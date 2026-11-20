// Expo configures the pnpm workspace itself (watch folders, node_modules lookup) since SDK 52.
// The one addition: the workspace's TypeScript packages import siblings as "./models.js", the
// spelling TypeScript requires under verbatimModuleSyntax, while the files on disk are ".ts".
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const workspacePackages = path.resolve(__dirname, "../../packages") + path.sep;

config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    context,
    moduleName.startsWith(".") &&
      moduleName.endsWith(".js") &&
      context.originModulePath.startsWith(workspacePackages)
      ? moduleName.slice(0, -".js".length)
      : moduleName,
    platform,
  );

module.exports = config;
