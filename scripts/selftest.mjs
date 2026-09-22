/**
 * dsh-credentials-admin 自测：纯编辑函数 + 与 dsh 官方解析器的兼容性。
 *
 * 只**读**真实凭据文件（内容不打印、不写入），所有写入都在内存文本上做。
 * 跑法：node scripts/selftest.mjs
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local";
import { decodeScalar, encodeScalar, listRefs, removeRef, setRef } from "../index.js";

let pass = 0;
let fail = 0;
const ok = (label, condition, extra = "") => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra ? `  ${extra}` : ""}`);
  }
};
const parses = (text, file = "selftest") => {
  try {
    parseCredentialsDocument(text, file);
    return true;
  } catch (error) {
    console.log(`       ${error.message}`);
    return false;
  }
};
const recordsOf = (text) => text.slice(text.indexOf("records:"));

const SAMPLE = `version: 1
refs:
  ALPHA: one
  BETA: "two: three"
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: abc123
`;

console.log("== 标量往返（编码后必须能被还原）==");
for (const value of ["simple", "with space", "colon: here", "#hash", "中文值", 'quo"te', "line\nbreak", "a'b", "123", "$dollar", "{brace}", "tab\there"]) {
  ok(`往返 ${JSON.stringify(value)}`, decodeScalar(encodeScalar(value)) === value, `→ ${encodeScalar(value)}`);
}

console.log("== list 只给名字与状态，不给值 ==");
const listed = listRefs(SAMPLE);
ok("名字顺序齐全", listed.map((row) => row.name).join(",") === "ALPHA,BETA", JSON.stringify(listed));
ok("没有任何值/长度字段", listed.every((row) => !("value" in row) && !("length" in row)), JSON.stringify(listed[0]));

console.log("== 新增 / 覆盖 ==");
const added = setRef(SAMPLE, "GAMMA", "new: value");
ok("新增标记 replaced=false", added.replaced === false);
ok("新增后官方解析器接受", parses(added.text));
ok("新增的值可还原", decodeScalar(added.text.split("\n").find((line) => line.includes("GAMMA")).slice(9)) === "new: value");
const over = setRef(SAMPLE, "ALPHA", "changed");
ok("覆盖标记 replaced=true", over.replaced === true);
ok("覆盖后 ALPHA 只有一行", over.text.split("\n").filter((line) => line.startsWith("  ALPHA:")).length === 1);
ok("覆盖后 ALPHA 值为 changed", over.text.split("\n").includes("  ALPHA: changed"));

console.log("== records 段一字未动 ==");
ok("新增不动 records", recordsOf(added.text) === recordsOf(SAMPLE));
ok("覆盖不动 records", recordsOf(over.text) === recordsOf(SAMPLE));
ok("删除不动 records", recordsOf(removeRef(SAMPLE, "ALPHA").text) === recordsOf(SAMPLE));

console.log("== 删除 ==");
const dropped = removeRef(SAMPLE, "ALPHA");
ok("删除标记 removed=true", dropped.removed === true);
ok("删除后 ALPHA 消失", !dropped.text.includes("ALPHA"));
ok("删除后官方解析器接受", parses(dropped.text));
ok("删除不存在的返回 false", removeRef(SAMPLE, "NOPE").removed === false);

console.log("== 真实文件兼容性（只读，绝不写）==");
const real = join(homedir(), ".dsh", ".credentials.yaml");
try {
  const text = await readFile(real, "utf8");
  const names = listRefs(text);
  ok("真实文件本身可被官方解析", parses(text, real));
  ok("真实文件读到了凭据", names.length > 0, `${names.length} 条`);
  const probe = setRef(text, "SELFTEST_PROBE", "x");
  ok("真实文件 + 新增后官方仍接受", parses(probe.text, real));
  const roundTrip = removeRef(probe.text, "SELFTEST_PROBE");
  ok("增删往返后与原文逐字节相同", roundTrip.text === text);
  console.log(`  （只读：${names.length} 条凭据 → ${names.map((row) => row.name).join(", ")}）`);
} catch (error) {
  console.log(`  跳过：${error.message}`);
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
