const fs = require("fs");
const path = require("path");

const targetPath = path.join(__dirname, "public/js/bundle.js");

let parser = null;
try {
    parser = require("acorn");
} catch (e) {}

if (!parser) {
    try {
        parser = require("esprima");
    } catch (e2) {}
}

if (!parser) {
    console.log("No parser found (acorn/esprima). Install one to validate: npm install -D acorn");
    process.exit(0);
}

const code = fs.readFileSync(targetPath, "utf8");
const errors = [];

try {
    if (parser.parse) {
        const result = parser.parse(code, {
            sourceType: "script",
            ecmaVersion: "latest",
            locations: true,
            recoverable: true
        });
        if (result && typeof result.errors === "object" && Array.isArray(result.errors)) {
            const parseErrors = result.errors.filter(e => e.type !== "EarlyError" && e.loc);
            for (const e of parseErrors) {
                const line = e.loc.line;
                const col = e.loc.column;
                errors.push(`Line ${line}:${col} ${e.type} ${e.message || ""}`);
            }
        } else if (typeof result === "string" && result) {
            console.log("Parser returned a string result (esprima-style).");
        }
    }
} catch (err) {
    if (parser === require("acorn") || (parser && parser.parse)) {
        if (err && err.message) {
            console.log("Parser threw:", err.message);
            errors.push(err.message);
        }
    } else {
        console.log("Parser threw during parse:", err && err.message);
        errors.push(err && err.message);
    }
}

if (parser === require("esprima") || (parser && parser.parse === undefined)) {
    try {
        const ast = parser.parse(code, { sourceType: "script", tolerant: true, loc: true });
        if (ast && typeof ast.errors === "object" && Array.isArray(ast.errors)) {
            for (const e of ast.errors) {
                const line = e.lineNumber || e.line || "?";
                const col = (e.column || e.col || "?");
                errors.push(`Line ${line}:${col} ${e.message || e.error || e.type || ""}`);
            }
        }
    } catch (e) {
        console.log("Esprima threw:", e && e.message);
        errors.push(e && e.message);
    }
}

if (errors.length === 0) {
    console.log("public/js/bundle.js parsed without recoverable parse errors (acorn/esprima).");
    process.exit(0);
}

// Also report any top-level recoverable parse issue explicitly.
console.log(errors.slice(0, 50).join("\n"));
process.exit(errors.length > 0 ? 2 : 0);
