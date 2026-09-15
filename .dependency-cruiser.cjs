/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "The package graph and the module graph are acyclic.",
      from: {},
      to: { circular: true },
    },
    {
      name: "ai-ui-is-a-library",
      severity: "error",
      comment: "effect-ai-ui is publishable. It imports effect and itself, nothing from the workspace.",
      from: { path: "^packages/ai-ui/src" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/ai-ui/" },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "@q/domain is the shared kernel: schemas and errors only. It imports effect, effect-ai-ui (which is effect only) and itself.",
      from: { path: "^packages/domain/src" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/(domain|ai-ui)/" },
    },
    {
      name: "config-is-a-leaf",
      severity: "error",
      comment: "@q/config reads the environment. It depends on nothing in the workspace.",
      from: { path: "^packages/config/src" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/config/" },
    },
    {
      name: "api-definition-depends-on-domain-only",
      severity: "error",
      comment: "The HTTP contract is shared by client and server. It may reach the domain and nothing else.",
      from: { path: "^packages/api-definition/src" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/(api-definition|domain|ai-ui)/" },
    },
    {
      name: "db-does-not-import-core",
      severity: "error",
      comment: "@q/db is the client and the migrations. Tables belong to modules in @q/core, which sit above it.",
      from: { path: "^packages/db/src" },
      to: { path: "^packages/(core|client|tui|api-definition)/|^apps/" },
    },
    {
      name: "core-does-not-import-outward",
      severity: "error",
      comment: "@q/core is business logic. It does not know about storage clients, transports, screens or the binary.",
      from: { path: "^packages/core/src", pathNot: "\\.test\\.tsx?$" },
      to: { path: "^packages/(db|client|tui|api-definition|test|factories)/|^apps/" },
    },
    {
      name: "client-does-not-import-core",
      severity: "error",
      comment: "A client reaches the server through the API contract, never through core services.",
      from: { path: "^packages/client/src", pathNot: "\\.test\\.tsx?$" },
      to: { path: "^packages/(core|db|tui)/|^apps/" },
    },
    {
      name: "tui-does-not-import-core",
      severity: "error",
      comment: "The screen is a projection of the client program.",
      from: { path: "^packages/tui/src", pathNot: "\\.test\\.tsx?$" },
      to: { path: "^packages/(core|db|api-definition)/|^apps/" },
    },
    {
      name: "no-cross-module-repository-imports",
      severity: "error",
      comment: "A repository is private to its module. Other modules go through the module's service.",
      from: { path: "^packages/core/src/([^/]+)/" },
      to: { path: "^packages/core/src/([^/]+)/[^/]*-repository\\.ts$", pathNot: "^packages/core/src/$1/" },
    },
    {
      name: "handlers-do-not-import-repositories",
      severity: "error",
      comment: "API handlers speak to services. Persistence is a module's private concern.",
      from: { path: "^apps/q/src/api/" },
      to: { path: "-repository\\.ts$" },
    },
    {
      name: "runtime-code-does-not-import-test-packages",
      severity: "error",
      comment: "@q/test and @q/factories are for tests. Runtime code never imports them.",
      from: { path: "^(packages|apps)/[^/]+/src/", pathNot: "\\.test\\.tsx?$|\\.fixture\\.ts$|^packages/(test|factories)/" },
      to: { path: "^packages/(test|factories)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules|dist" },
    // TypeScript 7 has no compiler API yet; swc parses the sources instead.
    parser: "swc",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
