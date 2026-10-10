export default {
  paths: ["features/**/*.feature"],
  import: [
    "features/support/tsx-register.mjs",
    "features/support/world.ts",
    "features/steps/**/*.ts",
  ],
  format: ["progress"],
  strict: true,
};
