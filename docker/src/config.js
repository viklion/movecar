require('dotenv').config();

module.exports = {
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: '0.0.0.0'
  },
  bark: {
    url: process.env.BARK_URL || '',
    icon: 'https://cdn-icons-png.flaticon.com/512/741/741407.png'
  },
  phone: {
    number: process.env.PHONE_NUMBER || '',
    // 是否隐藏手机号，true=只有车主确认后才显示，false=发送通知后就显示（默认：false）
    hideUntilConfirmed: process.env.HIDE_PHONE_NUMBER === 'true'
  },
  car: {
    number: process.env.CAR_NUMBER || ''
  },
  storage: {
    ttl: parseInt(process.env.KV_TTL, 10) || 3600,
    statusTtl: 600
  },
  security: {
    allowedCountries: process.env.ALLOWED_COUNTRIES ? process.env.ALLOWED_COUNTRIES.split(',') : null,
    enableGeoCheck: process.env.ENABLE_GEO_CHECK === 'true'
  },
  rateLimit: {
    // 5分钟内最多发送次数，0表示不限制，默认不限制
    maxRequestsPer5Min: parseInt(process.env.RATE_LIMIT_5MIN, 10) || 0,
    // 每天最多发送次数，0表示不限制，默认不限制
    maxRequestsPerDay: parseInt(process.env.RATE_LIMIT_DAILY, 10) || 0
  },
  ipConfirmation: {
    // IP确认缓存时间（秒），默认0表示关闭此功能，设置大于0的值启用
    recordTime: process.env.RECORD_TIME !== undefined ? parseInt(process.env.RECORD_TIME, 10) : 0
  }
};
