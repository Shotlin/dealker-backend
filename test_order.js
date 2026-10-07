async function createOrder() {
  const accountUrl = 'http://127.0.0.1:3000/api/auth/send-otp';
  const verifyUrl = 'http://127.0.0.1:3000/api/auth/verify-otp';
  const getAddressUrl = 'http://127.0.0.1:3000/api/users/me/addresses'; // if we need it
  const orderUrl = 'http://127.0.0.1:3000/api/orders';

  try {
    console.log("1. Sending OTP to 6297831930...");
    await fetch(accountUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '6297831930' })
    });
    
    console.log("2. Verifying OTP...");
    const verifyRes = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '6297831930', otp: '123456' })
    });
    const authData = await verifyRes.json();
    if (!authData.tokens || !authData.tokens.accessToken) {
      console.error("Failed to login", authData);
      return;
    }
    const token = authData.tokens.accessToken;
    console.log("✓ Logged in");

    console.log("3. Fetching Addresses...");
    const addressRes = await fetch(getAddressUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const addrData = await addressRes.json();
    const addresses = addrData.data || addrData;
    const addressId = Array.isArray(addresses) && addresses.length > 0 ? addresses[0].id : '2d9a8262-7ce4-4540-9ff4-6fc05faaa5f3';
    console.log("✓ Using Address ID:", addressId);

    const orderReq = {
      deliveryAddressId: addressId,
      items: [
        {
          productId: 'b0a13e64-e00e-44dc-ad91-6c0216f94e73',
          quantity: 1
        }
      ],
      paymentMethod: 'COD'
    };

    console.log("4. Creating new test order...");
    const orderRes = await fetch(orderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(orderReq)
    });
    const orderData = await orderRes.json();
    console.log("✓ Order Creation Result:", JSON.stringify(orderData, null, 2));
  } catch (err) {
    console.error("Script Error:", err);
  }
}

createOrder();
