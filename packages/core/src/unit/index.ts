/**
 * @fileoverview
 * @summary The Unit module (ARCHITECTURE §3): `unit.ts` defines what a unit is, `kernel.ts` runs them.
 * @description
 * `runtime.ts` (`UnitRuntime`) is the kernel's internal engine and is not
 * re-exported here: applications get at it only through `Kernel`.
 * @author MathAid
 */

export * from './kernel';
export * from './unit';
