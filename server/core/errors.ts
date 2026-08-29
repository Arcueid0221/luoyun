/**
 * "这条 cookie 不再代表一个登录用户" 的统一信号。
 *
 * 为什么值得单独一个类型：MUSIC_U 过期和 Luoyun 自己出故障，对调用方是两件
 * 完全不同的事 —— 前者要提示人重新粘一次 cookie（HTTP 401），后者才是 5xx、
 * 该重试或该报警。Provider 那边只有拿到一个能 instanceof 的类型才能分开处理，
 * 靠 match message 里的中文迟早会错。
 */
export class AuthExpiredError extends Error {
  constructor(message = '登录已失效，请重新填入 MUSIC_U') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

/**
 * 网易云表示"需要登录"的方式是 HTTP 200 + 业务码 301，不是 401。
 *
 * 只认 301：别的非 200 业务码（无版权、参数错、风控）都是真的失败，
 * 误判成"登录失效"会让调用方把管理员送去重新登录一个其实还活着的账号。
 */
export function isLoginRequiredCode(code: number | undefined): boolean {
  return code === 301;
}
