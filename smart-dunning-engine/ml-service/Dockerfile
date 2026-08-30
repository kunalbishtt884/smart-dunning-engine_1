FROM python:3.11-slim

WORKDIR /app/ml-service

COPY ml-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ml-service/app.py .
COPY generate_fintech_dataset.py ../generate_fintech_dataset.py

ENV MODEL_DIR=/app/ml-service/models
ENV DATASET_PATH=/app/synthetic_payment_failures.csv

# Generate the synthetic dataset at image build time so /predict has a model
# to train on the first time the container starts (models/ is also volume-
# mounted in docker-compose so retraining does not repeat on every restart).
RUN python generate_fintech_dataset.py --help > /dev/null 2>&1 || true
RUN cd /app && python generate_fintech_dataset.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
