// Kiểm tra chữ ký HS256 của một id_token THẬT do SSO wrapper cấp, đối chiếu với
// giá trị OIDC_SHARED_SECRET mà backend đang dùng.
//
// Backend chỉ báo "token signature is not valid" — nó không nói được secret sai
// hay chỉ sai cách mã hoá. Script này thử lần lượt các cách suy ra khoá HMAC từ
// một chuỗi secret, và chỉ ra cách nào khớp (nếu có).
//
//   node scripts/diag-token-secret.mjs '<id_token>' '<secret>'
//
// Lấy id_token thật: đăng nhập rồi mở console của side panel, dòng log
// "[netMind] sign-in failed …" đi kèm object có chứa token; hoặc bắt response
// của POST https://netmind.viettel.vn/sso-wrapper/token trong tab Network.
import { createHmac, timingSafeEqual } from 'node:crypto';

const [token, secret] = process.argv.slice(2);
if (!token || !secret) {
  console.error('Dùng: node scripts/diag-token-secret.mjs <id_token> <secret>');
  process.exit(1);
}

const parts = token.split('.');
if (parts.length !== 3) {
  console.error('✗ Không phải JWT: cần đúng 3 phần ngăn bởi dấu chấm.');
  process.exit(1);
}
const [h64, p64, sig64] = parts;

let header, claims;
try {
  header = JSON.parse(Buffer.from(h64, 'base64url').toString());
  claims = JSON.parse(Buffer.from(p64, 'base64url').toString());
} catch {
  console.error('✗ Header hoặc payload không phải base64url JSON.');
  process.exit(1);
}

console.log(`header : ${JSON.stringify(header)}`);
console.log(`iss    : ${claims.iss}`);
console.log(`aud    : ${JSON.stringify(claims.aud)}`);
console.log(`sub    : ${claims.sub}`);
console.log(`exp    : ${claims.exp} (${new Date(Number(claims.exp) * 1000).toISOString()})`);
console.log('');

const alg = String(header.alg || '').toUpperCase();
if (alg !== 'HS256') {
  console.log(`→ alg = ${alg}, không phải HS256. Backend ghim OIDC_ID_TOKEN_ALG=HS256`);
  console.log('  nên sẽ từ chối trước cả khi chọn khoá. Sửa OIDC_ID_TOKEN_ALG cho khớp,');
  console.log('  và nếu là RS256/ES256 thì cần JWKS_URL thay vì OIDC_SHARED_SECRET.');
  process.exit(1);
}

// Backend (python-jose) dùng ĐÚNG bytes UTF-8 của chuỗi secret. Các biến thể
// khác chỉ để chẩn đoán: nếu một biến thể khớp, secret là đúng nhưng phải nạp
// vào .env ở dạng mà UTF-8 của nó ra đúng bytes đó.
const candidates = [
  ['utf8 thô (đúng cái backend dùng)', Buffer.from(secret, 'utf8')],
  ['base64 chuẩn đã giải mã', tryDecode(secret, 'base64')],
  ['base64url đã giải mã', tryDecode(secret, 'base64url')],
  ['hex đã giải mã', /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0
    ? Buffer.from(secret, 'hex') : null],
];

function tryDecode(value, encoding) {
  try {
    const buf = Buffer.from(value, encoding);
    return buf.length ? buf : null;
  } catch { return null; }
}

const signed = Buffer.from(sig64, 'base64url');
let matched = null;
for (const [label, key] of candidates) {
  if (!key) { console.log(`–  ${label}: không giải mã được`); continue; }
  const actual = createHmac('sha256', key).update(`${h64}.${p64}`).digest();
  const ok = actual.length === signed.length && timingSafeEqual(actual, signed);
  if (ok) matched = label;
  console.log(`${ok ? '✓' : '✗'}  ${label} (${key.length} bytes)`);
}

console.log('');
if (matched === candidates[0][0]) {
  console.log('→ Secret ĐÚNG và đúng dạng. Lỗi chữ ký nằm ở chỗ khác:');
  console.log('  kiểm tra xem container có đang chạy đúng .env này không.');
} else if (matched) {
  console.log(`→ Secret đúng nhưng SAI DẠNG: wrapper ký bằng "${matched}".`);
  console.log('  Backend dùng bytes UTF-8 của chuỗi trong .env, nên phải nạp vào');
  console.log('  OIDC_SHARED_SECRET đúng chuỗi mà UTF-8 của nó ra bytes đó.');
} else {
  console.log('→ Không cách suy ra khoá nào khớp: OIDC_SHARED_SECRET KHÔNG PHẢI');
  console.log('  secret mà SSO wrapper dùng để ký. Xin đúng khoá ký HS256 của');
  console.log('  client "netmind-extension" từ đội vận hành sso-wrapper.');
}
