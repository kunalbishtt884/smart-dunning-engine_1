"""
ml-service/app.py

FastAPI microservice for the Autonomous Smart-Dunning & Mandate Salvage Engine.

Responsibilities:
  - Train a classifier (failure_classification) and a regressor
    (optimal_retry_delay_hours) from synthetic_payment_failures.csv.
  - Persist trained artifacts with joblib so the container can skip retraining
    on every restart.
  - Serve a /predict endpoint that the Node.js orchestrator calls for every
    DIAGNOSING-state transaction.

Run standalone:
    uvicorn app:app --host 0.0.0.0 --port 8000 --reload

On first boot (or when FORCE_RETRAIN=1) it will train from
../synthetic_payment_failures.csv if no model artifacts are found.
"""

from __future__ import annotations  # allows `X | None` type hints on Python 3.9+

import os
import logging
from typing import Literal

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingRegressor, RandomForestClassifier
from sklearn.metrics import accuracy_score, mean_absolute_error
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ml-service] %(message)s")
logger = logging.getLogger("ml-service")

MODEL_DIR = os.getenv("MODEL_DIR", "./models")
DATASET_PATH = os.getenv("DATASET_PATH", "../synthetic_payment_failures.csv")
CLASSIFIER_PATH = os.path.join(MODEL_DIR, "failure_classifier.joblib")
REGRESSOR_PATH = os.path.join(MODEL_DIR, "retry_delay_regressor.joblib")
FORCE_RETRAIN = os.getenv("FORCE_RETRAIN", "0") == "1"

CATEGORICAL_FEATURES = ["bank_code", "payment_method", "error_code"]
NUMERIC_FEATURES = [
    "timestamp_hour",
    "day_of_month",
    "amount_inr",
    "past_user_failure_count",
]
ALL_FEATURES = CATEGORICAL_FEATURES + NUMERIC_FEATURES

app = FastAPI(
    title="Smart-Dunning ML Diagnostic Core",
    description="Diagnoses failed-payment root cause and predicts optimal retry delay.",
    version="1.0.0",
)

_classifier: Pipeline | None = None
_regressor: Pipeline | None = None


def _build_preprocessor() -> ColumnTransformer:
    return ColumnTransformer(
        transformers=[
            ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL_FEATURES),
        ],
        remainder="passthrough",
    )


def train_models() -> dict:
    if not os.path.exists(DATASET_PATH):
        raise FileNotFoundError(
            f"Dataset not found at {DATASET_PATH}. Run generate_fintech_dataset.py first."
        )

    logger.info("Loading dataset from %s", DATASET_PATH)
    df = pd.read_csv(DATASET_PATH)

    X = df[ALL_FEATURES]
    y_cls = df["failure_classification"]
    y_reg = df["optimal_retry_delay_hours"]

    X_train, X_test, ycls_train, ycls_test, yreg_train, yreg_test = train_test_split(
        X, y_cls, y_reg, test_size=0.2, random_state=42, stratify=y_cls
    )

    classifier = Pipeline(
        steps=[
            ("preprocess", _build_preprocessor()),
            (
                "model",
                RandomForestClassifier(
                    n_estimators=250, max_depth=14, random_state=42, n_jobs=-1
                ),
            ),
        ]
    )
    classifier.fit(X_train, ycls_train)
    cls_acc = accuracy_score(ycls_test, classifier.predict(X_test))

    regressor = Pipeline(
        steps=[
            ("preprocess", _build_preprocessor()),
            (
                "model",
                GradientBoostingRegressor(
                    n_estimators=300, max_depth=4, learning_rate=0.05, random_state=42
                ),
            ),
        ]
    )
    regressor.fit(X_train, yreg_train)
    reg_mae = mean_absolute_error(yreg_test, regressor.predict(X_test))

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump(classifier, CLASSIFIER_PATH)
    joblib.dump(regressor, REGRESSOR_PATH)

    logger.info(
        "Training complete. classifier_accuracy=%.4f regressor_mae_hours=%.4f",
        cls_acc,
        reg_mae,
    )

    global _classifier, _regressor
    _classifier = classifier
    _regressor = regressor

    return {"classifier_accuracy": round(cls_acc, 4), "regressor_mae_hours": round(reg_mae, 4)}


def load_models():
    global _classifier, _regressor
    if (
        not FORCE_RETRAIN
        and os.path.exists(CLASSIFIER_PATH)
        and os.path.exists(REGRESSOR_PATH)
    ):
        logger.info("Loading cached model artifacts from %s", MODEL_DIR)
        _classifier = joblib.load(CLASSIFIER_PATH)
        _regressor = joblib.load(REGRESSOR_PATH)
        return
    logger.info("No cached artifacts found (or FORCE_RETRAIN=1) — training now.")
    train_models()


@app.on_event("startup")
def on_startup():
    load_models()


class DiagnosisRequest(BaseModel):
    transaction_id: str
    bank_code: Literal["HDFC", "SBI", "ICICI", "AXIS", "KOTAK"]
    payment_method: Literal["UPI_AUTOPAY", "DEBIT_CARD_MANDATE", "CREDIT_CARD"]
    error_code: Literal[
        "GATEWAY_DOWNTIME", "INSUFFICIENT_FUNDS", "AUTHENTICATION_TIMEOUT", "CARD_EXPIRED"
    ]
    timestamp_hour: int = Field(ge=0, le=23)
    day_of_month: int = Field(ge=1, le=31)
    amount_inr: float = Field(gt=0)
    past_user_failure_count: int = Field(ge=0, le=50)


class DiagnosisResponse(BaseModel):
    transaction_id: str
    failure_classification: str
    confidence: float
    optimal_retry_delay_hours: float
    recommended_action: Literal["QUEUED_RETRY", "SMART_LINK_DISPATCHED"]
    rationale: str


TERMINAL_CLASSES = {"TERMINAL_FAIL"}
# Anything predicted to need more than this many hours of delay is better
# served by an immediate smart payment link than a scheduled silent retry.
SMART_LINK_DELAY_THRESHOLD_HOURS = 168.0  # 7 days


@app.get("/health")
def health():
    return {
        "status": "ok",
        "classifier_loaded": _classifier is not None,
        "regressor_loaded": _regressor is not None,
    }


@app.post("/train")
def retrain():
    try:
        metrics = train_models()
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "trained", "metrics": metrics}


@app.post("/predict", response_model=DiagnosisResponse)
def predict(req: DiagnosisRequest):
    if _classifier is None or _regressor is None:
        raise HTTPException(status_code=503, detail="Models not loaded yet.")

    row = pd.DataFrame([{
        "bank_code": req.bank_code,
        "payment_method": req.payment_method,
        "error_code": req.error_code,
        "timestamp_hour": req.timestamp_hour,
        "day_of_month": req.day_of_month,
        "amount_inr": req.amount_inr,
        "past_user_failure_count": req.past_user_failure_count,
    }])

    pred_class = _classifier.predict(row)[0]
    proba = _classifier.predict_proba(row)[0]
    confidence = float(np.max(proba))

    pred_delay = float(max(0.1, _regressor.predict(row)[0]))

    if pred_class in TERMINAL_CLASSES or pred_delay > SMART_LINK_DELAY_THRESHOLD_HOURS:
        action = "SMART_LINK_DISPATCHED"
        rationale = (
            f"Predicted class '{pred_class}' with recommended delay "
            f"{pred_delay:.1f}h exceeds the {SMART_LINK_DELAY_THRESHOLD_HOURS:.0f}h "
            "auto-retry threshold, or the failure is terminal — dispatching a "
            "smart payment link instead of a silent retry."
        )
    else:
        action = "QUEUED_RETRY"
        rationale = (
            f"Predicted class '{pred_class}' (confidence {confidence:.2f}) is "
            f"recoverable — queuing an automated retry in {pred_delay:.1f}h, "
            "the model's estimated peak-success window."
        )

    return DiagnosisResponse(
        transaction_id=req.transaction_id,
        failure_classification=pred_class,
        confidence=round(confidence, 4),
        optimal_retry_delay_hours=round(pred_delay, 2),
        recommended_action=action,
        rationale=rationale,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
