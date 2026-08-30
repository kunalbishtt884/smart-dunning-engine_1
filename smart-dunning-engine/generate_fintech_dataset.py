"""
generate_fintech_dataset.py

Generates a realistic synthetic dataset of failed subscription payments for the
Autonomous Smart-Dunning & Mandate Salvage Engine.

Output: synthetic_payment_failures.csv (10,000+ rows)

Design notes on the synthetic signal (so the ML model has something real to learn):
  - GATEWAY_DOWNTIME failures cluster heavily between 01:00-03:30 (bank maintenance
    windows) and recover fast -> short optimal_retry_delay_hours.
  - INSUFFICIENT_FUNDS (liquidity) failures cluster on days 25-31 and 1-5 (salary
    cycle) and need a longer delay (wait for salary credit) -> long
    optimal_retry_delay_hours, worse with higher past_user_failure_count.
  - AUTHENTICATION_TIMEOUT is roughly uniform across time, needs a short retry
    (user just needs to re-attempt OTP/3DS), and correlates weakly with
    UPI_AUTOPAY / DEBIT_CARD_MANDATE.
  - CARD_EXPIRED (-> TERMINAL_FAIL) is time-independent, cannot be recovered by
    retrying, and demands a smart payment-link dispatch instead of a retry.
"""

import csv
import random
import uuid
from datetime import datetime

random.seed(42)

N_ROWS = 12000

BANKS = ["HDFC", "SBI", "ICICI", "AXIS", "KOTAK"]
BANK_WEIGHTS = [0.24, 0.28, 0.20, 0.16, 0.12]

PAYMENT_METHODS = ["UPI_AUTOPAY", "DEBIT_CARD_MANDATE", "CREDIT_CARD"]
PAYMENT_METHOD_WEIGHTS = [0.52, 0.30, 0.18]

ERROR_CODES = [
    "GATEWAY_DOWNTIME",
    "INSUFFICIENT_FUNDS",
    "AUTHENTICATION_TIMEOUT",
    "CARD_EXPIRED",
]

FAILURE_CLASSIFICATION_MAP = {
    "GATEWAY_DOWNTIME": "TRANSIENT_DOWNTIME",
    "INSUFFICIENT_FUNDS": "LIQUIDITY_DEFICIT",
    "AUTHENTICATION_TIMEOUT": "AUTH_EXPIRY",
    "CARD_EXPIRED": "TERMINAL_FAIL",
}


def weighted_choice(options, weights):
    return random.choices(options, weights=weights, k=1)[0]


def sample_hour_for_error(error_code):
    """Return an hour (0-23) with realistic clustering per error type."""
    if error_code == "GATEWAY_DOWNTIME":
        # 70% chance the failure lands in the 01:00-03:30 maintenance window.
        if random.random() < 0.70:
            return round(random.uniform(1.0, 3.5))
        return random.randint(0, 23)
    if error_code == "INSUFFICIENT_FUNDS":
        # Liquidity failures skew slightly towards evenings (post-work spending
        # checks) but are not strongly hour-dependent.
        return random.choices(
            population=range(24),
            weights=[1 if h not in range(18, 23) else 2 for h in range(24)],
        )[0]
    # AUTHENTICATION_TIMEOUT / CARD_EXPIRED: roughly uniform across the day.
    return random.randint(0, 23)


def sample_day_for_error(error_code):
    """Return a day_of_month (1-31) with realistic clustering per error type."""
    if error_code == "INSUFFICIENT_FUNDS":
        # 65% chance failure lands in the end-of-month / start-of-month
        # low-liquidity window (25-31 or 1-5).
        if random.random() < 0.65:
            if random.random() < 0.55:
                return random.randint(25, 31)
            return random.randint(1, 5)
        return random.randint(6, 24)
    # Other error types: uniform across the month.
    return random.randint(1, 31)


def sample_amount(payment_method):
    if payment_method == "CREDIT_CARD":
        return round(random.uniform(499, 50000), 2)
    if payment_method == "DEBIT_CARD_MANDATE":
        return round(random.uniform(299, 25000), 2)
    return round(random.uniform(199, 15000), 2)  # UPI_AUTOPAY: typically smaller


def sample_past_failure_count(error_code):
    if error_code == "INSUFFICIENT_FUNDS":
        # Liquidity-deficit users tend to have a repeat-failure history.
        return random.choices([0, 1, 2, 3, 4, 5], weights=[10, 20, 25, 20, 15, 10])[0]
    if error_code == "CARD_EXPIRED":
        return random.choices([0, 1, 2, 3, 4, 5], weights=[30, 25, 20, 12, 8, 5])[0]
    return random.choices([0, 1, 2, 3, 4, 5], weights=[45, 25, 15, 8, 4, 3])[0]


def compute_optimal_retry_delay(error_code, hour, day, past_failure_count):
    """
    Floating point regression target: hours until the peak-probability retry
    window. This is the label a regressor will learn to predict.
    """
    if error_code == "GATEWAY_DOWNTIME":
        # Bank maintenance windows typically clear by ~04:30-05:00.
        if 1.0 <= hour <= 3.5:
            base = (5.0 - hour) % 24
        else:
            base = random.uniform(0.5, 2.5)
        noise = random.gauss(0, 0.3)
        return round(max(0.25, base + noise), 2)

    if error_code == "INSUFFICIENT_FUNDS":
        # Wait for the next salary-credit cycle (typically the 1st-3rd).
        if day >= 25:
            days_to_credit = (32 - day) + random.uniform(0, 2)  # roll into next month
        elif day <= 5:
            days_to_credit = random.uniform(0.5, 3.0)
        else:
            days_to_credit = random.uniform(3.0, 10.0)
        base_hours = days_to_credit * 24
        # More prior failures -> the model recommends waiting a bit longer to
        # avoid repeated bounces.
        base_hours *= 1 + (0.05 * past_failure_count)
        noise = random.gauss(0, 6)
        return round(max(2.0, base_hours + noise), 2)

    if error_code == "AUTHENTICATION_TIMEOUT":
        # Short, near-immediate retry once the user completes auth.
        base = random.uniform(0.1, 1.5)
        return round(max(0.1, base + random.gauss(0, 0.2)), 2)

    # CARD_EXPIRED / TERMINAL_FAIL: retrying doesn't help; delay is effectively
    # "never" for auto-retry, encoded as a large sentinel value pushing the
    # orchestrator towards SMART_LINK_DISPATCHED instead of QUEUED_RETRY.
    return round(random.uniform(720.0, 2160.0), 2)  # 30-90 days


def generate_row():
    payment_method = weighted_choice(PAYMENT_METHODS, PAYMENT_METHOD_WEIGHTS)
    bank_code = weighted_choice(BANKS, BANK_WEIGHTS)

    # AUTHENTICATION_TIMEOUT correlates weakly with UPI_AUTOPAY / DEBIT_CARD_MANDATE
    # (3DS / OTP heavy flows); CARD_EXPIRED only makes sense for card rails.
    if payment_method == "UPI_AUTOPAY":
        error_weights = [0.30, 0.32, 0.34, 0.04]
    elif payment_method == "DEBIT_CARD_MANDATE":
        error_weights = [0.28, 0.30, 0.24, 0.18]
    else:  # CREDIT_CARD
        error_weights = [0.22, 0.18, 0.20, 0.40]

    error_code = weighted_choice(ERROR_CODES, error_weights)
    hour = sample_hour_for_error(error_code)
    day = sample_day_for_error(error_code)
    amount = sample_amount(payment_method)
    past_failures = sample_past_failure_count(error_code)
    retry_delay = compute_optimal_retry_delay(error_code, hour, day, past_failures)
    classification = FAILURE_CLASSIFICATION_MAP[error_code]

    return {
        "transaction_id": str(uuid.uuid4()),
        "bank_code": bank_code,
        "payment_method": payment_method,
        "error_code": error_code,
        "timestamp_hour": hour,
        "day_of_month": day,
        "amount_inr": amount,
        "past_user_failure_count": past_failures,
        "failure_classification": classification,
        "optimal_retry_delay_hours": retry_delay,
    }


def main():
    fieldnames = [
        "transaction_id",
        "bank_code",
        "payment_method",
        "error_code",
        "timestamp_hour",
        "day_of_month",
        "amount_inr",
        "past_user_failure_count",
        "failure_classification",
        "optimal_retry_delay_hours",
    ]

    out_path = "synthetic_payment_failures.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for _ in range(N_ROWS):
            writer.writerow(generate_row())

    print(f"[{datetime.now().isoformat(timespec='seconds')}] "
          f"Wrote {N_ROWS} rows to {out_path}")


if __name__ == "__main__":
    main()
