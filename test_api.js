import pg from 'pg';
import jwt from 'jsonwebtoken';

async function testApi() {
  const token = jwt.sign({ id: '11ded7fa-9d8a-478e-bd39-19f37420e3ff', role: 'RIDER', phone: '6297831930' }, '727a0f40b7f51d720a054ab35bd3ee1f1ffdf9ce923c828c9b35ec173543dc00bb400ab29aa372d90ab1a7f4b9aee5a1', { expiresIn: '15m' });

  const res = await fetch('http://127.0.0.1:3000/api/v1/delivery/orders', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  const text = await res.text();
  console.log("Status:", res.status);
  console.log("Body:", text);
}
testApi();
