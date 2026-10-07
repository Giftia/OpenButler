"use strict";

// Electron's default app loads a supplied entry with dynamic import(), which
// does not make require.main === module true for a CommonJS entry. Keep this
// explicit launcher separate so importing the probe in Node tests stays inert.
require("./check-macos-capabilities.cjs").main();
