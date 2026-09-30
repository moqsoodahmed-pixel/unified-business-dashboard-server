export const ok = (res, data = {}, message = 'OK', status = 200) =>
  res.status(status).json({ success: true, message, data });

export const created = (res, data = {}, message = 'Created') => ok(res, data, message, 201);

export const fail = (res, status, message, errorCode = 'ERROR', data = null) =>
  res.status(status).json({ success: false, message, errorCode, data });
