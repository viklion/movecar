class MemoryStorage {
  constructor() {
    this.store = new Map();
    this.timers = new Map();
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
}

module.exports = new MemoryStorage();
