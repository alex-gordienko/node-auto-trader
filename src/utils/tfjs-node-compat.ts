import util from "node:util";

type NodeUtilCompat = typeof util & {
  isNullOrUndefined?: (value: unknown) => value is null | undefined;
  isArray?: (value: unknown) => value is unknown[];
};

const nodeUtil = util as NodeUtilCompat;

if (typeof nodeUtil.isNullOrUndefined !== "function") {
  nodeUtil.isNullOrUndefined = (value: unknown): value is null | undefined => value === null || value === undefined;
}

if (typeof nodeUtil.isArray !== "function") {
  nodeUtil.isArray = Array.isArray;
}
