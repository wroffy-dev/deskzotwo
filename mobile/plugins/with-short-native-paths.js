const { withAppBuildGradle, withProjectBuildGradle } = require("expo/config-plugins");

/**
 * Building on Windows: React Native's codegen puts C++ sources so deep that CMake's object files land past
 * Windows' 260-character path limit ("Filename longer than 260 characters"), and turning long paths on in
 * Windows isn't ours to do. Two things together keep every path under it:
 *
 *   · CMake builds in a short folder (~/.deskzo-cxx) instead of android/app/.cxx — on Windows only.
 *   · CMake's object paths are capped at 240, so it shortens the long ones to a hash itself.
 *   · Libraries that build C++ of their own (react-native-worklets, since 0.13 — 9 Nov 2026) build in a short folder
 *     each too, ~/.deskzo-cxx/<library>, instead of node_modules/<library>/android/.cxx.
 *
 * CMake can only shorten a name whose hashed form fits under the cap after the folder it builds in, so the
 * cap alone isn't enough from deep inside the project: 128 and 160 shortened nothing, and 240 left the
 * longest file names (which don't fit hashed) over the limit in a release's longer folder.
 */
const CAP = "-DCMAKE_OBJECT_PATH_MAX=";
const STAGING = ".deskzo-cxx";

const LIBRARIES = "short folders for native libraries";

function withShortLibraryPaths(config) {
  return withProjectBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes(LIBRARIES)) {
      mod.modResults.contents += `
// Windows' 260-character limit (plugins/with-short-native-paths.js): ${LIBRARIES}.
if (System.getProperty("os.name").toLowerCase().contains("windows")) {
    subprojects { p ->
        p.plugins.withId("com.android.library") {
            p.android.externalNativeBuild.cmake.buildStagingDirectory = new File(System.getProperty("user.home"), "${STAGING}/" + p.name)
        }
    }
}
`;
    }
    return mod;
  });
}

module.exports = function withShortNativePaths(config) {
  config = withShortLibraryPaths(config);
  return withAppBuildGradle(config, (mod) => {
    let text = mod.modResults.contents;
    if (!text.includes(CAP)) {
      const anchor = /defaultConfig\s*\{/;
      if (!anchor.test(text)) throw new Error("with-short-native-paths: no defaultConfig in app/build.gradle");
      text = text.replace(
        anchor,
        (found) => `${found}\n        externalNativeBuild {\n            cmake {\n                // Windows' 260-character limit (plugins/with-short-native-paths.js).\n                arguments "${CAP}240"\n            }\n        }`,
      );
    }
    if (!text.includes(STAGING)) {
      text += `\n// Windows' 260-character limit (plugins/with-short-native-paths.js): CMake builds in a short folder.\nif (System.getProperty("os.name").toLowerCase().contains("windows")) {\n    android.externalNativeBuild.cmake.buildStagingDirectory = new File(System.getProperty("user.home"), "${STAGING}")\n}\n`;
    }
    mod.modResults.contents = text;
    return mod;
  });
};
