/**
 * dsh-phone-bridge · 版本与协议常量
 *
 * 证据等级：[官方源码] —— 数值为本插件自定义，非 DSH 内部常量。
 */

/** 插件（桥）自身语义化版本。 */
export const BRIDGE_VERSION = '3.8.3';

/** 协议契约版本。手机端必须在 hello 中回传 contractVersion。 */
export const CONTRACT_VERSION = 3;

/** 本桥仍能服务的最低契约版本；低于它必须显式报 BRIDGE_INCOMPATIBLE。 */
export const MIN_CONTRACT_VERSION = 3;

/** 握手标识，便于手机端识别对端确实是 dsh-phone-bridge。 */
export const PROTOCOL = 'dsh-phone-bridge';
