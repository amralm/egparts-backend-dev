require('dotenv').config();
const resolver = require('./middleware/tenantResolver');

const req = {
  path: '/api/store-context',
  headers: {
    'x-original-host': 'egparts.store'
  },
  query: {}
};

const res = {
  status: function(code) {
    console.log('Response Status:', code);
    return this;
  },
  json: function(data) {
    console.log('Response JSON:', data);
    return this;
  }
};

const next = () => {
  console.log('Next called successfully!');
  console.log('Store context on request:', req.store);
  console.log('Context on request:', req.context);
};

resolver(req, res, next);
