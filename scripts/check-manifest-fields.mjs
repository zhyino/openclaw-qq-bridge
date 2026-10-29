/**
 * Manifest/type field guard.
 *
 * `openclaw.plugin.json` declares the account schema with
 * `additionalProperties: false`, so any field present on
 * `OneBotAccountConfig` but missing from the manifest is rejected at config
 * time — the user writes it, the validator refuses it, and nothing says why.
 * That is how `mediaAllowDirs` stayed invisible for three releases.
 *
 * v0.3.2: the first version of this script only looked at
 * `channelConfigs.onebot.schema.properties`. The *account* node
 * (`$defs.account`, reached through `properties.accounts.additionalProperties`)
 * was never checked, so the same five security fields were still missing one
 * level down — visible only to people running more than one QQ number.
 *
 * The rule is now positional and exhaustive: every object node in the schema
 * that is closed (`additionalProperties: false`) must declare every field the
 * plugin can read at that level. Adding a field to `OneBotAccountConfig` means
 * adding it to *both* the channel schema and the account schema, or this
 * script fails.
 *
 * The check stays one-way:
 *   TS ⊆ schema   must hold  (otherwise we ship a field no one can configure)
 *   schema ⊃ TS   allowed    (the host injects its own channel fields)
 *
 * Exit code 1 on violation so `npm run verify` and CI fail loudly.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Fields that only make sense at channel level; never required per account. */
export const CHANNEL_ONLY_FIELDS = new Set(["accounts"]);

/** Every schema node a user actually writes account settings into. */
export const CONFIG_LEVELS = ["#", "#/$defs/account"];

/** The controls that must be configurable at *every* level that reads them. */
export const SECURITY_FIELDS = [
  "ownerQQ",
  "outboundAllow",
  "outboundDeny",
  "replyAudit",
  "mediaAllowDirs",
];

/**
 * Parse `export interface OneBotAccountConfig { ... }` out of src/types.ts.
 * Brace-matched rather than regex-terminated so nested object literals in the
 * interface body cannot truncate the match.
 */
export function readTypedFields(typesSource) {
  const start = typesSource.indexOf("export interface OneBotAccountConfig {");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = typesSource.indexOf("{", start); i < typesSource.length; i++) {
    const ch = typesSource[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = typesSource.slice(start, end + 1);
  return (body.match(/^\s+([a-zA-Z][a-zA-Z0-9]*)\??:/gm) ?? []).map((s) =>
    s.trim().replace(/\??:$/, ""),
  );
}

/**
 * Collect every closed object node (`additionalProperties: false` + properties)
 * anywhere in the schema, with the JSON path that leads to it.
 *
 * `$ref` nodes are skipped: the definition they point at lives under `$defs`
 * and is visited on its own, so resolving the reference here would report the
 * same node twice under two different names.
 */
export function collectClosedObjects(schema) {
  const found = [];
  const seen = new Set();

  const walk = (node, path) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (typeof node.$ref === "string") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (node.type === "object" && node.additionalProperties === false && node.properties) {
      found.push({ path, properties: Object.keys(node.properties) });
    }

    for (const [key, value] of Object.entries(node)) {
      if (value === null || typeof value !== "object") continue;
      if (key === "properties" || key === "$defs") {
        const segment = key === "$defs" ? "$defs" : "properties";
        for (const [name, child] of Object.entries(value)) {
          walk(child, `${path}/${segment}/${name}`);
        }
      } else if (key === "additionalProperties") {
        walk(value, `${path}/{additionalProperties}`);
      } else if (key === "items") {
        walk(value, `${path}/items`);
      } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
        (Array.isArray(value) ? value : [value]).forEach((child, i) => walk(child, `${path}/${key}[${i}]`));
      }
    }
  };

  walk(schema, "#");
  return found;
}

/**
 * Audit a parsed manifest against the typed field list.
 * Returns an array of human-readable violations; empty means OK.
 */
export function auditManifest({ schema, typedFields }) {
  const violations = [];
  const channelProps = Object.keys(schema?.properties ?? {});

  if (!schema?.properties) {
    return ["channelConfigs.onebot.schema.properties missing"];
  }

  // 1. Channel level must declare every typed field.
  for (const field of typedFields) {
    if (!channelProps.includes(field)) {
      violations.push(`channel schema: "${field}" typed in types.ts but not declared (additionalProperties:false hides it)`);
    }
  }

  // 2. Both config-carrying levels must declare the security controls. Nested
  //    shapes like `$defs.commands` are closed objects too, but they describe a
  //    sub-record, not a place a user configures `ownerQQ`.
  const closed = collectClosedObjects(schema);
  for (const path of CONFIG_LEVELS) {
    const node = closed.find((n) => n.path === path);
    if (!node) {
      violations.push(`config level ${path} not found as a closed object — schema shape changed`);
      continue;
    }
    for (const field of SECURITY_FIELDS) {
      if (!node.properties.includes(field)) {
        violations.push(`${path}: security field "${field}" missing`);
      }
    }
  }

  // 3. Account level must declare every typed field a per-account config can
  //    carry — i.e. everything except the channel-only ones.
  const accountRef = schema?.properties?.accounts?.additionalProperties?.$ref;
  const accountNode = closed.find((n) => n.path === "#/$defs/account");
  if (!accountNode) {
    violations.push('account schema missing: expected a closed object at #/$defs/account (channelConfigs.onebot.schema.$defs.account)');
  } else {
    if (accountRef !== "#/$defs/account") {
      violations.push(
        `properties.accounts.additionalProperties should $ref "#/$defs/account" but points at ${JSON.stringify(accountRef)}`,
      );
    }
    for (const field of typedFields) {
      if (CHANNEL_ONLY_FIELDS.has(field)) continue;
      if (!accountNode.properties.includes(field)) {
        violations.push(
          `#/$defs/account: "${field}" is read per account (config.ts resolveOneBotAccount) but not declared there`,
        );
      }
    }
    // A per-account node may never declare something the channel level does not.
    for (const field of accountNode.properties) {
      if (!channelProps.includes(field)) {
        violations.push(`#/$defs/account: "${field}" declared per account but absent from the channel schema`);
      }
    }
  }

  // 4. Guard the guard: a channel-only field must never be a security control.
  for (const field of CHANNEL_ONLY_FIELDS) {
    if (SECURITY_FIELDS.includes(field)) {
      violations.push(`CHANNEL_ONLY_FIELDS includes security control "${field}" — that exclusion is not allowed`);
    }
  }

  return violations;
}

export function loadAndAudit({ manifestPath = "openclaw.plugin.json", typesPath = "src/types.ts" } = {}) {
  const typedFields = readTypedFields(readFileSync(typesPath, "utf8"));
  if (!typedFields) {
    return { typedFields: null, schema: null, violations: [`could not find OneBotAccountConfig in ${typesPath}`] };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schema = manifest?.channelConfigs?.onebot?.schema;
  return { typedFields, schema, violations: auditManifest({ schema, typedFields }) };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const { typedFields, schema, violations } = loadAndAudit();
  if (!typedFields) {
    console.error(`check-manifest-fields: ${violations[0]}`);
    process.exit(1);
  }
  const closed = collectClosedObjects(schema);
  console.log(
    `check-manifest-fields: ${typedFields.length} typed fields, ${closed.length} closed schema node(s): ${closed
      .map((n) => n.path)
      .join(", ")}`,
  );
  if (violations.length > 0) {
    console.error(`\nFAIL — ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\nWith additionalProperties: false these fields cannot be configured at the level named above.\n` +
        `Mirror the field (and its description) into openclaw.plugin.json at that node.`,
    );
    process.exit(1);
  }
  console.log("  OK — every typed field is configurable at the level that reads it");
}
