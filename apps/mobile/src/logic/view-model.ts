// A small expression evaluator for the show_view formula language. It never evaluates JavaScript.
export type ViewNode = { type: string; id?: string; children?: ViewNode[]; let?: Record<string, string>; [key: string]: unknown };
export type PendingView = { id: string; title?: string; view: ViewNode; askedAt?: number; conversationId?: string; sessionId?: string };

export function inputValues(view: ViewNode): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null);
  function visit(node: ViewNode) {
    if (node.id && ["slider", "number", "choice", "toggle"].includes(node.type)) {
      const option = Array.isArray(node.options) ? node.options[0] : undefined;
      values[node.id] = node.value ?? (node.type === "toggle" ? false : node.type === "choice" ? (typeof option === "object" && option !== null ? option.value ?? option.label : option) ?? "" : node.min ?? 0);
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }
  visit(view);
  return values;
}

type Token = { kind: string; value: string };
const tokenPattern = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z_0-9]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(<=|>=|==|!=|&&|\|\||[+*/%()!,?:<>-]))/y;
export function formula(source: string, names: Record<string, unknown>): unknown {
  if (source.length > 500) return undefined;
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    if (/^\s*$/.test(source.slice(position))) break;
    tokenPattern.lastIndex = position;
    const match = tokenPattern.exec(source);
    if (!match || tokens.length > 120) return undefined;
    tokens.push({ kind: match[1] ? "number" : match[2] ? "name" : match[3] ? "string" : "op", value: match[1] ?? match[2] ?? match[3] ?? match[4] });
    position = tokenPattern.lastIndex;
  }
  const functions: Record<string, (...args: number[]) => unknown> = {
    min: Math.min, max: Math.max, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
    sqrt: Math.sqrt, pow: Math.pow, round: Math.round,
    clamp: (value, low, high) => Math.min(high, Math.max(low, value)),
    fixed: (value, digits = 0) => value.toFixed(Math.min(6, Math.max(0, digits))),
    format: (value, digits = 0) => value.toLocaleString("en-US", { minimumFractionDigits: Math.min(6, Math.max(0, digits)), maximumFractionDigits: Math.min(6, Math.max(0, digits)) }),
    percent: (value, digits = 0) => `${(value * 100).toFixed(Math.min(6, Math.max(0, digits)))}%`,
  };
  let at = 0;
  const peek = () => tokens[at]?.value;
  const take = (value: string) => { if (peek() === value) { at++; return true; } return false; };
  function expression(min = 0): unknown {
    const token = tokens[at++];
    if (!token) throw Error("incomplete");
    let left: unknown;
    if (token.value === "(" ) { left = expression(); if (!take(")")) throw Error("missing )"); }
    else if (token.value === "!" || token.value === "-" || token.value === "+") {
      const operand = expression(8);
      left = token.value === "!" ? !operand : token.value === "-" ? -Number(operand) : Number(operand);
    } else if (token.kind === "number") left = Number(token.value);
    else if (token.kind === "string") left = token.value[0] === '"' ? JSON.parse(token.value) : token.value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    else if (token.kind === "name") {
      if (take("(")) {
        if (!Object.hasOwn(functions, token.value)) throw Error("unknown function");
        const args: number[] = [];
        if (!take(")")) {
          do { args.push(Number(expression())); } while (take(","));
          if (!take(")")) throw Error("missing )");
        }
        left = functions[token.value](...args);
      } else left = token.value === "true" ? true : token.value === "false" ? false : Object.hasOwn(names, token.value) ? names[token.value] : undefined;
    } else throw Error("unexpected token");
    const priority: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
    while (peek()) {
      if (peek() === "?" && min <= 0) {
        at++; const yes = expression(); if (!take(":")) throw Error("missing :");
        const no = expression(); left = left ? yes : no; continue;
      }
      const op = peek()!; const order = priority[op];
      if (!order || order < min) break;
      at++; const right = expression(order + 1);
      switch (op) {
        case "+": left = typeof left === "string" || typeof right === "string" ? String(left) + String(right) : Number(left) + Number(right); break;
        case "-": left = Number(left) - Number(right); break;
        case "*": left = Number(left) * Number(right); break;
        case "/": left = Number(left) / Number(right); break;
        case "%": left = Number(left) % Number(right); break;
        case "<": left = Number(left) < Number(right); break;
        case "<=": left = Number(left) <= Number(right); break;
        case ">": left = Number(left) > Number(right); break;
        case ">=": left = Number(left) >= Number(right); break;
        case "==": left = left === right; break;
        case "!=": left = left !== right; break;
        case "&&": left = Boolean(left && right); break;
        case "||": left = Boolean(left || right); break;
      }
    }
    return left;
  }
  try { const result = expression(); return at === tokens.length && !(typeof result === "number" && !Number.isFinite(result)) ? result : undefined; }
  catch { return undefined; }
}

export function scope(view: ViewNode, inputs: Record<string, unknown>): Record<string, unknown> {
  const names: Record<string, unknown> = Object.assign(Object.create(null), inputs);
  if (view.let && typeof view.let === "object") {
    for (const [name, expression] of Object.entries(view.let)) {
      if (/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) && !Object.hasOwn(names, name) && typeof expression === "string") names[name] = formula(expression, names);
    }
  }
  return names;
}
export function resolve(value: unknown, names: Record<string, unknown>): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { "=": unknown })["="] === "string") return formula((value as { "=": string })["="], names);
  return value;
}
export function shown(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
