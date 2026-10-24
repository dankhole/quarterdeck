import type { BuildOptions } from "esbuild";

export declare const QUARTERDECK_ESBUILD_EXTERNAL: string[];
export declare const QUARTERDECK_CJS_SHIM_BANNER: string;
export declare function createQuarterdeckEsbuildOptions(buildId: string): BuildOptions;
export declare function createPiLifecycleEsbuildOptions(): BuildOptions;
