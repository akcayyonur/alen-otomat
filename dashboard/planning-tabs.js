/**
 * Planlama sekmelerinin kullaniciya gore filtrelenmesi (tarayıcıdan bağımsız, testli: backend/apps.test.js).
 * Hangi kullanici hangi sekmeyi gorur? Admin hepsini; digerleri kendi rolunun grants'inda (shared/screens.js
 * id'leriyle) en az 'read' yetkisi olan ekranlari gorur. Yetkiyi sunucu verir (backend/auth/policy.js); bu
 * tablo yalniz menuyu ve acilis sekmesini belirler.
 */
import { PLANNING_SCREENS } from './screens.js';

/** Menudeki sira: shared/screens.js'teki planlama ekranlarinin sirasi. */
export const TAB_ORDER = Object.freeze(PLANNING_SCREENS.map((s) => s.id));

/**
 * @param {{isAdmin?: boolean, grants?: Record<string,string>|null}|null} user
 * @param {string[]} [closed] bu kurulumda kapali bolumler (config/features.json): kimse (admin dahil) gormez
 */
export const tabsForUser = (user, closed = []) => {
  if (!user) return [];
  return TAB_ORDER.filter((k) => (user.isAdmin || !!user.grants?.[k]) && !closed.includes(k));
};

/** Girişte açılan sekme: admin iş emirlerini, diğerleri kendi görebildiklerinden ilkini görür. */
export const defaultTabFor = (user, closed = []) => {
  if (user?.isAdmin) return 'isemirleri';
  return tabsForUser(user, closed)[0] ?? 'tezgahbasi';
};
