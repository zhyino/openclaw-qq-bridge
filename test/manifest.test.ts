import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { auditManifest, readTypedFields } from "../scripts/check-manifest-fields.mjs";

/**
 * The manifest schema is the only config contract that exists at runtime:
 * TypeScript types are erased, so a field that lives only in `types.ts` cannot
 * be configured at all when `additionalProperties` is false.
 *
 * v0.3.1 shipped with the five security controls declared at channel level but
 * missing from `$defs.account`. A single-account deployment worked; the moment
 * someone added a second QQ number, `ownerQQ` / `outboundAllow` were rejected
 * by the validator. These tests exist because "declared at the top" is not the
 * same as "declared where the user writes it".
 */
describe("plugin manifest schema", () => {
  const repoRoot = join(process.cwd());
  const manifest = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf8"));
  const schema = manifest.channelConfigs.onebot.schema;
  const declared = new Set(Object.keys(schema.properties));

  const typesSource = readFileSync(join(repoRoot, "src", "types.ts"), "utf8");
  const typed: string[] = readTypedFields(typesSource) ?? [];

  const SECURITY_FIELDS = ["ownerQQ", "outboundAllow", "outboundDeny", "replyAudit", "mediaAllowDirs"];

  it("declares every field the plugin actually reads", () => {
    expect(typed.length).toBeGreaterThan(0);
    const missing = typed.filter((f) => !declared.has(f));
    expect(missing, `fields typed in src/types.ts but absent from the manifest: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("declares the security controls explicitly", () => {
    for (const field of SECURITY_FIELDS) {
      expect(declared.has(field), `${field} must be configurable`).toBe(true);
    }
  });

  it("declares the security controls per account, not only at channel level", () => {
    const account = schema.$defs.account;
    expect(account.additionalProperties).toBe(false);
    const accountFields = Object.keys(account.properties);
    const missing = SECURITY_FIELDS.filter((f) => !accountFields.includes(f));
    expect(
      missing,
      `per-account config cannot set: ${missing.join(", ")} — a second QQ number would silently lose these controls`,
    ).toEqual([]);
  });

  it("gives the per-account security controls the same description as channel level", () => {
    // Two copies of a field must not drift into two different explanations.
    for (const field of SECURITY_FIELDS) {
      expect(schema.$defs.account.properties[field].description, `${field} description`).toBe(
        schema.properties[field].description,
      );
    }
  });

  it("accepts a real multi-account config that sets per-account security controls", () => {
    // Field-name matching alone cannot prove the schema *validates*: types,
    // patterns and $refs all matter. Compile it and feed it a realistic config.
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const config = {
      wsUrl: "ws://127.0.0.1:3001",
      accounts: {
        master: {
          wsUrl: "ws://127.0.0.1:3002",
          ownerQQ: "100001",
          allowFrom: ["private:100001"],
          outboundAllow: ["private:100001", "group:*"],
          outboundDeny: ["group:123456"],
          replyAudit: true,
          mediaAllowDirs: ["/srv/media"],
        },
        partner: {
          wsUrl: "ws://127.0.0.1:3003",
          ownerQQ: "200002",
          allowFrom: ["private:200002"],
          outboundAllow: ["private:200002"],
          replyAudit: false,
        },
      },
    };
    const ok = validate(config);
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects an unknown per-account field (the schema is actually closed)", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const ok = validate({ accounts: { master: { wsUrl: "ws://x", totallyInventedField: 1 } } });
    expect(ok).toBe(false);
  });

  it("the guard fails when a per-account security field is removed", () => {
    // Proves the guard is not vacuously green: delete one field and it must
    // report that exact node, which is what v0.3.1 shipped unnoticed.
    const broken = JSON.parse(JSON.stringify(schema));
    delete broken.$defs.account.properties.ownerQQ;
    const violations = auditManifest({ schema: broken, typedFields: typed });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("#/$defs/account");
    expect(violations.join("\n")).toContain("ownerQQ");
  });

  it("the guard passes on the manifest as shipped", () => {
    expect(auditManifest({ schema, typedFields: typed })).toEqual([]);
  });

  it("keeps mediaAllowDirs an array of strings with an empty default", () => {
    const field = schema.properties.mediaAllowDirs;
    expect(field.type).toBe("array");
    expect(field.items.type).toBe("string");
    expect(field.default).toEqual([]);
  });

  it("defaults replyAudit to enabled", () => {
    expect(schema.properties.replyAudit.default).toBe(true);
  });
});
