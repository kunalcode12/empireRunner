/**
 * The meta layer's public surface.
 *
 * Everything outside `src/game/meta/` imports from here.
 *
 * ## Currency has exactly one door
 *
 * `EconomyBackend` is it. `foldLedger` and `appendTransaction` are exported
 * because the backend implementations and the save validator need them, but no
 * screen and no gameplay code should reach for them — a balance read anywhere
 * other than through the backend is the thing `backend.ts` exists to prevent.
 */

export {
  createLocalEconomyBackend,
  createMemoryLedgerStore,
  createNullEconomyBackend,
  type CommitResult,
  type EconomyBackend,
  type LedgerStore,
} from "./backend";

export {
  Currency,
  EMPTY_LEDGER,
  LedgerRejection,
  ZERO_BALANCES,
  appendTransaction,
  bitsEarned,
  canAfford,
  foldLedger,
  fractureShardCost,
  transactionDelta,
  type Balances,
  type CurrencyName,
  type Ledger,
  type LedgerEntry,
  type LedgerRejectionValue,
  type Transaction,
} from "./economy";

export {
  UPGRADES,
  UPGRADE_TRACKS,
  UpgradeTrack,
  ZERO_UPGRADES,
  bitValueMultiplier,
  canPurchase,
  effectFraction,
  effectMultiplier,
  effectValue,
  formatUpgradeTable,
  fullClearCost,
  shieldCount,
  upgradeCost,
  upgradeCostRange,
  upgradeTable,
  upgradeTrackTotal,
  withTier,
  type UpgradeDefinition,
  type UpgradeLevels,
  type UpgradeTableRow,
  type UpgradeTrackName,
} from "./upgrades";

export {
  AVATARS,
  DEFAULT_AVATAR_ID,
  PassiveDomain,
  UnlockKind,
  avatarBitMultiplier,
  avatarById,
  avatarFlowMultiplier,
  challengeAvatars,
  challengesMetBy,
  type Avatar,
  type AvatarPassive,
  type AvatarUnlock,
  type AvatarVisual,
} from "./avatars";

export {
  BOOSTS,
  BOOST_IDS,
  Boost,
  CosmeticSlot,
  EMPTY_INVENTORY,
  addConsumable,
  boostBitMultiplier,
  consume,
  consumeLoadout,
  countOf,
  equipAvatar,
  equipBoost,
  equipCosmetic,
  loadout,
  ownAvatar,
  ownCosmetic,
  unequipBoost,
  unequipCosmetic,
  type BoostDefinition,
  type BoostId,
  type CosmeticSlotName,
  type Inventory,
  type LoadoutView,
} from "./inventory";

export {
  DAILY_POOL,
  MissionMetric,
  MissionUnit,
  WEEKLY_POOL,
  type MissionMetricName,
  type MissionTemplate,
  type MissionUnitName,
  type WeeklyTemplate,
} from "./missionPool";

export {
  applyRun as applyRunToMissions,
  claimRewards,
  closestUnmet,
  dailyMissionsFor,
  dailyStatuses,
  emptyMissionProgress,
  formatShortfall,
  readMetric,
  rollPeriods,
  utcDayKey,
  utcWeekKey,
  weeklyContractFor,
  weeklyStatuses,
  type MissionProgress,
  type MissionRewards,
  type MissionStatus,
} from "./missions";

export {
  FRESH_ONBOARDING,
  Unlockable,
  ZERO_LIFETIME,
  applyRunToLifetime,
  distanceForLevel,
  isFirstRun,
  isUnlocked,
  levelForDistance,
  levelProgress,
  markSeen,
  newlyUnlocked,
  type LevelProgress,
  type LifetimeStats,
  type OnboardingFlags,
  type UnlockableName,
} from "./progression";

export {
  LATEST_VERSION,
  SAVE_KEY,
  createMemorySaveStorage,
  createSaveManager,
  defaultSaveStorage,
  freshSave,
  migrate,
  parseSave,
  serializeSave,
  type ParsedSave,
  type RemoteSyncAdapter,
  type SaveData,
  type SaveManager,
  type SaveStorage,
} from "./save";

export {
  CoinKind,
  buildRunSummary,
  createRunRecorder,
  emptyRunSummary,
  recordEvent,
  recordFlow,
  resetRunRecorder,
  themeForDistance,
  type RunEndState,
  type RunRecorder,
  type RunSummary,
} from "./runSummary";

export { settleRun, type RunSettlement } from "./settle";
