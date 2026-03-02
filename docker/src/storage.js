class MemoryStorage {
  constructor() {
    this.store = new Map();
    this.timers = new Map();
    this.ipRateLimit = new Map(); // IP限流记录：{ ip: { count5min: [], countDaily: [] } }
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    
    return item.value;
  }

  async put(key, value, options = {}) {
    const expiresAt = options.expirationTtl 
      ? Date.now() + (options.expirationTtl * 1000)
      : null;
    
    this.store.set(key, { value, expiresAt });
    
    if (expiresAt) {
      const existingTimer = this.timers.get(key);
      if (existingTimer) clearTimeout(existingTimer);
      
      const timer = setTimeout(() => {
        this.store.delete(key);
        this.timers.delete(key);
      }, options.expirationTtl * 1000);
      
      this.timers.set(key, timer);
    }
    
    return;
  }

  async delete(key) {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.store.delete(key);
    return;
  }

  // IP限流检查
  // options: { maxRequestsPer5Min, maxRequestsPerDay }
  checkRateLimit(ip, options = {}) {
    const { maxRequestsPer5Min = 0, maxRequestsPerDay = 0 } = options;
    
    // 如果都设置为0（不限制），直接返回allowed=true
    if (maxRequestsPer5Min === 0 && maxRequestsPerDay === 0) {
      return {
        allowed: true,
        violations: { tooFrequent: false, dailyExceeded: false },
        count5min: 0,
        countDaily: 0
      };
    }

    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    const dayStart = new Date(now).setHours(0, 0, 0, 0);

    if (!this.ipRateLimit.has(ip)) {
      this.ipRateLimit.set(ip, { count5min: [], countDaily: [] });
    }

    const ipData = this.ipRateLimit.get(ip);

    // 清理5分钟外的记录
    ipData.count5min = ipData.count5min.filter(time => time > fiveMinutesAgo);

    // 清理非今天的记录
    ipData.countDaily = ipData.countDaily.filter(time => time > dayStart);

    // 检查限制（0表示不限制）
    const violations = {
      tooFrequent: maxRequestsPer5Min > 0 && ipData.count5min.length >= maxRequestsPer5Min,
      dailyExceeded: maxRequestsPerDay > 0 && ipData.countDaily.length >= maxRequestsPerDay
    };

    return {
      allowed: !violations.tooFrequent && !violations.dailyExceeded,
      violations,
      count5min: ipData.count5min.length,
      countDaily: ipData.countDaily.length
    };
  }

  // 记录IP请求
  recordRequest(ip) {
    const now = Date.now();
    
    if (!this.ipRateLimit.has(ip)) {
      this.ipRateLimit.set(ip, { count5min: [], countDaily: [] });
    }

    const ipData = this.ipRateLimit.get(ip);
    ipData.count5min.push(now);
    ipData.countDaily.push(now);
  }

  // 清除IP限流记录
  clearIPLimit(ip) {
    if (this.ipRateLimit.has(ip)) {
      this.ipRateLimit.delete(ip);
    }
  }

  // 清除所有IP限流记录
  clearAllIPLimits() {
    this.ipRateLimit.clear();
  }

  // 记录IP请求已被确认
  // recordTime: 过期时间（秒），默认10分钟
  recordIPConfirmed(ip, recordTime = 600) {
    const now = Date.now();
    const key = `ip_confirmed_${ip}`;
    this.put(key, { timestamp: now }, { expirationTtl: recordTime });
  }

  // 检查IP是否在10分钟内有确认记录
  async isIPConfirmedRecently(ip) {
    const key = `ip_confirmed_${ip}`;
    const data = await this.get(key);
    return data !== null;
  }

  // 清除所有IP确认缓存（容器重启时调用）
  clearAllIPConfirmations() {
    // 清除所有ip_confirmed_*的key
    for (const [key] of this.store) {
      if (key.startsWith('ip_confirmed_')) {
        this.store.delete(key);
        const timer = this.timers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
      }
    }
  }
}

module.exports = new MemoryStorage();
