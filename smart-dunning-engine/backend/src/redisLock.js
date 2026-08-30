// src/redisLock.js
// Idempotency Gatekeeper: a distributed Redis lock keyed on
// `lock:webhook:<payment_id>` that prevents two concurrent webhook deliveries
// (Razorpay retries webhooks on non-2xx / timeout) from double-processing the
// same payment event.

const { randomUUID } = require("crypto");

const LOCK_PREFIX = "lock:webhook:";
const DEFAULT_TTL_MS = 15000; // must comfortably exceed webhook handler runtime

// Lua script for a safe compare-and-delete unlock: only release the lock if
// the token we hold still matches what's in Redis (prevents releasing a lock
// that a different process has since acquired after our TTL expired).
const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

class RedisLock {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  /**
   * Attempt to acquire the lock for a given payment_id.
   * Returns a release() function if acquired, or null if another process
   * currently holds the lock (i.e. this webhook is a duplicate in-flight).
   */
  async acquire(paymentId, ttlMs = DEFAULT_TTL_MS) {
    const key = `${LOCK_PREFIX}${paymentId}`;
    const token = randomUUID();

    // SET key value NX PX ttl -> atomic acquire-if-absent with expiry.
    const result = await this.redis.set(key, token, "PX", ttlMs, "NX");

    if (result !== "OK") {
      return null; // Another webhook delivery is already processing this payment.
    }

    return async () => {
      await this.redis.eval(UNLOCK_SCRIPT, 1, key, token);
    };
  }
}

module.exports = { RedisLock, LOCK_PREFIX };
