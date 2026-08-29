// 写 stderr 而不是 stdout，避免和 Vite 自己的输出抢行。
// 打开方式：NETEASE_VERBOSE=1 npm run dev  /  NETEASE_DEBUG=1 npm run dev

const isDebug = !!process.env.NETEASE_DEBUG;
const isVerbose = isDebug || !!process.env.NETEASE_VERBOSE;

export function verbose(msg: string): void {
  if (isVerbose) process.stderr.write(`[luoyun] ${msg}\n`);
}

export function debug(msg: string): void {
  if (isDebug) process.stderr.write(`[luoyun:debug] ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`[luoyun:warn] ${msg}\n`);
}
