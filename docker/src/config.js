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
    number: process.env.PHONE_NUMBER || ''
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
  }
};
