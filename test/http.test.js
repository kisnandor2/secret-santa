import { describe, it } from 'node:test';

describe('http', () => {
  it.todo('healthz returns 200');
  it.todo('/ returns HTML with CSP header');
  it.todo('create/join round-trip status codes and bodies');
  it.todo('every error code returns {error,message} with right status');
  it.todo('malformed JSON gives 400 INVALID_INPUT');
  it.todo('body over 2kB gives 400 INVALID_INPUT');
  it.todo('api responses have Cache-Control no-store');
  it.todo('unknown /api path gives 404 JSON');
  it.todo('XSS-shaped name round-trips unchanged');
});
