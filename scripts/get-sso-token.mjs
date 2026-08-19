// Chạy đúng luồng authorization code + PKCE mà extension chạy, rồi kiểm tra
// /userinfo chấp nhận token nào. Trả lời dứt điểm câu hỏi: backend nên nhận
// id_token hay access_token.
//
//   node scripts/get-sso-token.mjs
//   node scripts/get-sso-token.mjs --show-tokens    # in đầy đủ token
//
// Script KHÔNG nhìn thấy mật khẩu của bạn: nó chỉ mở trang đăng nhập Viettel
// SSO trong trình duyệt và lắng nghe ở 127.0.0.1:47821 để nhận code trả về.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const WRAPPER = 'https://netmind.viettel.vn/sso-wrapper';
const CLIENT_ID = 'netmind-extension';
const SCOPES = 'openid profile email';
const PORT = 47821;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SHOW = process.argv.includes('--show-tokens');

const b64url = (buf) => buf.toString('base64url');
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const authUrl = `${WRAPPER}/authorize?` + new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  // Wrapper không echo nonce lại trong id_token, gửi nonce là tự làm hỏng
  // phiên đăng nhập — brand.config.json để oidcSendNonce=false vì lý do này.
});

function preview(token) {
  if (SHOW) return token;
  return `${token.slice(0, 24)}…${token.slice(-12)}  (${token.length} ký tự, dùng --show-tokens để xem đủ)`;
}

function describe(label, token) {
  console.log(`\n── ${label} ──`);
  console.log(preview(token));
  const parts = token.split('.');
  if (parts.length !== 3) {
    console.log('dạng   : token đục (không phải JWT)');
    return;
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    console.log(`header : ${JSON.stringify(header)}`);
    console.log(`sub    : ${claims.sub}`);
    console.log(`iss    : ${claims.iss}`);
    console.log(`aud    : ${JSON.stringify(claims.aud)}`);
    console.log(`exp    : ${new Date(Number(claims.exp) * 1000).toISOString()}`);
  } catch {
    console.log('dạng   : ba phần nhưng không giải mã được');
  }
}

async function probeUserinfo(label, token) {
  const response = await fetch(`${WRAPPER}/userinfo`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await response.text();
  const ok = response.status === 200;
  console.log(`${ok ? '✓' : '✗'} /userinfo với ${label}: HTTP ${response.status}  ${body.slice(0, 300)}`);
  return ok;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('not found');
    return;
  }

  const finish = (message) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">
      <p>${message}</p><p>Quay lại cửa sổ terminal để xem kết quả.</p></body>`);
  };

  const error = url.searchParams.get('error');
  if (error) {
    finish(`Đăng nhập thất bại: ${error}`);
    console.error(`\n✗ Wrapper trả lỗi: ${error} — ${url.searchParams.get('error_description') || ''}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  if (url.searchParams.get('state') !== state) {
    finish('State không khớp — dừng lại.');
    console.error('\n✗ state không khớp. Có thể bạn mở lại một URL cũ; chạy lại script.');
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    finish('Không nhận được code.');
    console.error('\n✗ Callback không kèm ?code=');
    server.close();
    process.exitCode = 1;
    return;
  }

  finish('Đã nhận code.');
  console.log('\n→ Nhận được authorization code, đang đổi lấy token…');

  const response = await fetch(`${WRAPPER}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    console.error(`\n✗ /token trả HTTP ${response.status}: ${raw.slice(0, 500)}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  let tokens;
  try { tokens = JSON.parse(raw); }
  catch { console.error(`\n✗ /token trả về thứ không phải JSON: ${raw.slice(0, 300)}`); server.close(); process.exitCode = 1; return; }

  console.log(`\nCác trường /token trả về: ${Object.keys(tokens).join(', ')}`);
  if (tokens.id_token) describe('id_token', tokens.id_token);
  if (tokens.access_token) describe('access_token', tokens.access_token);

  console.log('\n── Kiểm tra /userinfo ──');
  const idOk = tokens.id_token ? await probeUserinfo('id_token    ', tokens.id_token) : false;
  const accessOk = tokens.access_token ? await probeUserinfo('access_token', tokens.access_token) : false;

  console.log('\n── Kết luận ──');
  if (idOk) {
    console.log('/userinfo nhận id_token → extension KHÔNG cần sửa. Deploy backend là chạy.');
  } else if (accessOk) {
    console.log('/userinfo chỉ nhận access_token → extension phải giữ và gửi access_token');
    console.log('thay cho id_token khi gọi backend. Báo lại để sửa cloud-service.js.');
  } else {
    console.log('/userinfo từ chối cả hai. Hướng userinfo không dùng được —');
    console.log('cần hỏi đội wrapper xem endpoint này nhận loại token nào.');
  }

  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Đang lắng nghe ${REDIRECT_URI}\n`);
  console.log('Mở URL này trong trình duyệt rồi đăng nhập Viettel SSO:\n');
  console.log(authUrl.toString());
  console.log('');
  // macOS: mở sẵn cho tiện. Lỗi thì kệ, URL đã in ở trên.
  if (process.platform === 'darwin') spawn('open', [authUrl.toString()], { stdio: 'ignore' }).unref();
});

setTimeout(() => {
  console.error('\n✗ Quá 5 phút chưa đăng nhập xong. Chạy lại script.');
  server.close();
  process.exitCode = 1;
}, 300_000).unref();
