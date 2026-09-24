/**
 * Generates `docs/engine-api.md` from the TSDoc of the engine's public entry points (DOD P7,
 * research 05: builders read this file, never engine source).
 *
 *   pnpm --filter @sg/engine api-docs           # rewrite docs/engine-api.md
 *   pnpm --filter @sg/engine api-docs --check   # exit 1 if it is out of date
 *
 * `test/api-docs.test.ts` runs the same check in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG, "../..");
/** Where the generated reference lives. */
export const API_DOC_PATH = join(ROOT, "docs/engine-api.md");

/** The public entry points, in the order they are documented. */
const ENTRIES: { spec: string; file: string; blurb: string }[] = [
  {
    spec: "@sg/engine",
    file: "src/index.ts",
    blurb:
      "Game logic API (SPEC §9.3), `GameRunner`, `ctx.timing` and the scenario contract (SPEC §14). Safe for the server, bots and logic: no DOM, no three.js.",
  },
  {
    spec: "@sg/engine/client",
    file: "src/client-module.ts",
    blurb:
      "Client module API (SPEC §9.4) and the shell contracts it names. Imported by game clients only (DOM + three.js types).",
  },
  {
    spec: "@sg/engine/testing",
    file: "src/testing/index.ts",
    blurb:
      "The test kit every game uses: `runScript`, the contract suite (G4), the timed-bot sim and pacing report (G5, G14), `fakeContent`.",
  },
];

const posix = (p: string): string => p.split("\\").join("/");

function docOf(checker: ts.TypeChecker, symbol: ts.Symbol): string {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  const tags = symbol
    .getJsDocTags(checker)
    .filter((t) => ["throws", "typeParam", "param", "returns", "deprecated"].includes(t.name))
    .map((t) => {
      const body = ts.displayPartsToString(t.text ?? []).trim();
      return `- \`@${t.name}\` ${body}`.trimEnd();
    });
  return [text, tags.join("\n")].filter((s) => s !== "").join("\n\n");
}

/** A declaration's source text without its body (functions, methods) or initializer. */
function signatureText(node: ts.Node, checker: ts.TypeChecker, sf: ts.SourceFile): string {
  const start = node.getStart(sf);
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    const end = node.body ? node.body.getStart(sf) : node.end;
    return sf.text.slice(start, end).trim().replace(/\s*$/, ";");
  }
  if (ts.isVariableDeclaration(node)) {
    const type = node.type
      ? node.type.getText(sf)
      : checker.typeToString(
          checker.getTypeAtLocation(node),
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        );
    return `const ${node.name.getText(sf)}: ${type};`;
  }
  if (ts.isGetAccessorDeclaration(node)) {
    return `get ${node.name.getText(sf)}(): ${node.type ? node.type.getText(sf) : "unknown"};`;
  }
  if (ts.isPropertyDeclaration(node)) {
    return sf.text
      .slice(start, node.initializer ? node.initializer.pos : node.end)
      .trim()
      .replace(/[=;\s]*$/, ";");
  }
  return sf.text.slice(start, node.end).trim();
}

function classText(node: ts.ClassDeclaration, checker: ts.TypeChecker, sf: ts.SourceFile): string {
  const header = sf.text.slice(node.getStart(sf), node.members.pos).trim();
  const lines: string[] = [header];
  for (const member of node.members) {
    if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) continue;
    const mods = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
    if (
      mods.some(
        (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
      )
    )
      continue;
    const symbol = member.name !== undefined ? checker.getSymbolAtLocation(member.name) : undefined;
    const doc = symbol
      ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
      : "";
    if (doc !== "") {
      for (const line of doc.split("\n")) lines.push(`  // ${line}`.trimEnd());
    }
    const sig = signatureText(member, checker, sf)
      .split("\n")
      .map((l, i) => (i === 0 || /^[)}\]]/.test(l.trim()) ? `  ${l.trim()}` : `    ${l.trim()}`))
      .join("\n");
    lines.push(sig);
  }
  lines.push("}");
  return lines.join("\n");
}

/** The file's leading `@module` doc comment, as Markdown text (or ""). */
function moduleDoc(sf: ts.SourceFile): string {
  const match = /^(?:\/\/\/[^\n]*\n)*\s*\/\*\*([\s\S]*?)\*\//.exec(sf.text);
  const body = match?.[1] ?? "";
  if (!/@module|@packageDocumentation/.test(body)) return "";
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .filter((l) => !/^@(module|packageDocumentation)\b/.test(l.trim()))
    .join("\n")
    .trim();
}

function kindOf(node: ts.Node): string {
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isVariableDeclaration(node)) return "const";
  return "export";
}

/** Renders the whole reference as Markdown. */
export function renderApiDocs(): string {
  const program = ts.createProgram(
    ENTRIES.map((e) => join(PKG, e.file)),
    {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
      types: [],
    },
  );
  const checker = program.getTypeChecker();
  const out: string[] = [
    "# Engine API reference",
    "",
    "<!-- Generated from TSDoc by `pnpm --filter @sg/engine api-docs`. Do not edit by hand;",
    "     `packages/engine/test/api-docs.test.ts` fails when this file is stale. -->",
    "",
    "The public API of `@sg/engine`. Game builders read this file and SPEC §9.3, §9.4 and §14;",
    "they never need to read engine source. Every entry below is exported from the entry point",
    "named in its section heading.",
    "",
  ];
  for (const entry of ENTRIES) {
    const sf = program.getSourceFile(join(PKG, entry.file));
    if (sf === undefined) throw new Error(`api-docs: cannot load ${entry.file}`);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) throw new Error(`api-docs: ${entry.file} is not a module`);
    out.push(`## \`${entry.spec}\``, "", entry.blurb, "");
    const items = checker
      .getExportsOfModule(moduleSymbol)
      .map((s) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s))
      .flatMap((symbol) =>
        (symbol.getDeclarations() ?? []).slice(0, 1).map((decl) => ({ symbol, decl })),
      )
      .map(({ symbol, decl }) => ({
        symbol,
        decl,
        file: posix(relative(PKG, decl.getSourceFile().fileName)),
        pos: decl.getStart(),
      }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.pos - b.pos);
    let file = "";
    for (const { symbol, decl } of items) {
      const declFile = posix(relative(PKG, decl.getSourceFile().fileName));
      if (declFile !== file) {
        file = declFile;
        out.push(`### \`${file}\``, "");
        const about = moduleDoc(decl.getSourceFile());
        if (about !== "") out.push(about, "");
      }
      const dsf = decl.getSourceFile();
      const declarations = symbol.getDeclarations() ?? [decl];
      const code = ts.isClassDeclaration(decl)
        ? classText(decl, checker, dsf)
        : declarations
            .filter((d) => d.getSourceFile() === dsf)
            .map((d) => signatureText(d, checker, dsf))
            .join("\n");
      out.push(`#### ${symbol.getName()} (${kindOf(decl)})`, "");
      const doc = docOf(checker, symbol);
      if (doc !== "") out.push(doc, "");
      out.push("```ts", code.replace(/\r\n/g, "\n"), "```", "");
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** True when docs/engine-api.md matches what the TSDoc generates. */
export function apiDocsUpToDate(): boolean {
  let current: string;
  try {
    current = readFileSync(API_DOC_PATH, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return false;
  }
  return current === renderApiDocs();
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes("--check")) {
    if (!apiDocsUpToDate()) {
      console.error("docs/engine-api.md is stale: run `pnpm --filter @sg/engine api-docs`");
      process.exit(1);
    }
    console.log("docs/engine-api.md is up to date");
  } else {
    writeFileSync(API_DOC_PATH, renderApiDocs());
    console.log(`wrote ${posix(relative(ROOT, API_DOC_PATH))}`);
  }
}
