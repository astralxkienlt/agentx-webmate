// Chạy đúng những kiểm tra mà extension thực hiện trên ID token,
// để chỉ ra chính xác cái nào hỏng. Không cần cài lại extension.
//   node diag-token.mjs '<id_token>'
const CFG = {
  oidcIssuer: 'https://netmind.viettel.vn/sso-wrapper',
  oidcClientId: 'netmind-extension',
  oidcIdTokenAlg: 'HS256',
};
const token = process.argv[2];
if (!token) { console.error('Cần truyền id_token làm tham số'); process.exit(1); }

const seg = (i) => JSON.parse(Buffer.from(token.split('.')[i], 'base64url').toString());
let h, c;
try { h = seg(0); c = seg(1); }
catch { console.error('✗ Token không phải JWT hợp lệ (không tách được 3 phần base64url)'); process.exit(1); }

const strip = (v) => String(v || '').replace(/\/+$/, '');
const audOk = Array.isArray(c.aud) ? c.aud.includes(CFG.oidcClientId) : String(c.aud || '') === CFG.oidcClientId;

const rows = [
  ['alg     ', String(h.alg || '').toUpperCase() === CFG.oidcIdTokenAlg,
   `token=${h.alg}   extension chờ=${CFG.oidcIdTokenAlg}`],
  ['sub/exp ', !!c.sub && Number.isFinite(Number(c.exp)),
   `sub=${c.sub ?? '(THIẾU)'}  exp=${c.exp ?? '(THIẾU)'}`],
  ['issuer  ', strip(c.iss) === strip(CFG.oidcIssuer),
   `token=${c.iss}\n            extension chờ=${CFG.oidcIssuer}`],
  ['audience', audOk,
   `token=${JSON.stringify(c.aud)}   extension chờ="${CFG.oidcClientId}"`],
  ['nonce   ', c.nonce !== undefined,
   c.nonce === undefined ? 'THIẾU — wrapper phải trả lại nonce đã gửi ở /authorize' : 'có'],
  ['còn hạn ', Number(c.exp) * 1000 > Date.now(),
   `hết hạn ${new Date(Number(c.exp) * 1000).toISOString()} / hiện tại ${new Date().toISOString()}`],
];
let failed = 0;
for (const [name, ok, info] of rows) {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}  ${info}`);
}
console.log(failed ? `\n→ ${failed} kiểm tra hỏng. Extension từ chối token TRƯỚC khi gọi backend.`
                   : '\n→ Mọi kiểm tra phía client đều đạt. Lỗi nằm ở chỗ khác.');
