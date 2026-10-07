import { ThemeTabsRepository } from '../../../modules/theme-tabs/theme-tabs.repository.js'
import {
  normalizeMerchConfig,
} from '../../../modules/theme-tabs/theme-tabs.shared.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { cacheDeletePattern } from '../../../utils/cache.js'
import { cloudinary, extractCloudinaryAssetInfo } from '../../../config/cloudinary.js'
import { env } from '../../../config/env.js'
import { logger } from '../../../config/logger.js'
import { UploadsService } from '../../uploads/uploads.service.js'

const repo = new ThemeTabsRepository()
const uploadsService = new UploadsService()

function normalizeTextColor(value) {
  const normalized = `${value || ''}`.trim().toUpperCase()
  if (!normalized) {
    return null
  }

  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null
}

async function invalidateTabCaches() {
  await cacheDeletePattern('bakaloo:tab_manifest:*')
  await cacheDeletePattern('bakaloo:tab_home:*')
  await cacheDeletePattern('bakaloo:admin_theme_tabs:*')
  await cacheDeletePattern('bakaloo:tab_themes')
}

function compareTabsBySortOrder(a, b) {
  if (a.sort_order !== b.sort_order) {
    return a.sort_order - b.sort_order
  }

  const labelCompare = `${a.label || ''}`.localeCompare(`${b.label || ''}`)
  if (labelCompare !== 0) {
    return labelCompare
  }

  return `${a.id}`.localeCompare(`${b.id}`)
}

async function rebalanceStoreTabs(storeKey, preferredTab = null) {
  if (!storeKey) {
    return
  }

  const activeTabs = await repo.findAll({
    storeKey,
    status: 'active',
  })

  if (!activeTabs.length) {
    return
  }

  const remainingTabs = activeTabs
    .filter((tab) => !preferredTab || tab.id !== preferredTab.id)
    .sort(compareTabsBySortOrder)

  const orderedTabs = [...remainingTabs]

  if (preferredTab && preferredTab.status === 'active') {
    const preferredIndex = Number.isFinite(Number(preferredTab.sort_order))
      ? Number(preferredTab.sort_order)
      : orderedTabs.length
    const clampedIndex = Math.max(0, Math.min(preferredIndex, orderedTabs.length))
    orderedTabs.splice(clampedIndex, 0, preferredTab)
  }

  for (const [index, tab] of orderedTabs.entries()) {
    if (tab.sort_order === index) {
      continue
    }

    await repo.update(tab.id, { sort_order: index })
  }
}

function buildConflictError(message) {
  const err = new Error(message)
  err.statusCode = 409
  err.code = 'THEME_TAB_KEY_CONFLICT'
  return err
}

function isUniqueViolation(err) {
  return err && err.code === '23505'
}

export class ThemeTabsService {
  async list(filters) {
    return repo.findAll({
      storeKey: filters.store_key,
      status: filters.status,
    })
  }

  async getById(id) {
    return repo.findById(id)
  }

  async create(data, adminId, ip) {
    const storeKey = data.store_key
    const key = `${data.key}`.trim()
    const status = data.status || 'active'

    // Only an ACTIVE tab with the same key blocks creation. Archived tabs
    // may share a key (the unique index is partial on status='active').
    if (status === 'active') {
      const conflict = await repo.findByStoreAndKey(storeKey, key, { activeOnly: true })
      if (conflict) {
        throw buildConflictError(
          `An active tab with key "${key}" already exists for this store. Choose a different name or key.`
        )
      }
    }

    // Only one tab per store can be the app's default landing tab. Clear any
    // existing default before inserting the new row so the DB never has to
    // reject a transient two-defaults state (idx_theme_tabs_one_default_per_store).
    if (status === 'active' && data.is_default) {
      await repo.clearDefaultsExcept(storeKey, null)
    }

    let tab
    try {
      tab = await repo.create({
        ...data,
        key,
        label: `${data.label}`.trim(),
        image_url: `${data.image_url || ''}`.trim() || null,
        text_color: normalizeTextColor(data.text_color),
        merch_config: normalizeMerchConfig(data.merch_config),
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw buildConflictError(
          `An active tab with key "${key}" already exists for this store. Choose a different name or key.`
        )
      }
      throw err
    }

    if (tab.status === 'active') {
      await rebalanceStoreTabs(tab.store_key, tab)
    }

    await invalidateTabCaches()
    logAdminActivity(adminId, 'CREATE_THEME_TAB', 'theme_tab', tab.id, null, null, ip)
    return repo.findById(tab.id)
  }

  async update(id, data, adminId, ip) {
    const existing = await repo.findById(id)
    if (!existing) return null

    const storeKey = data.store_key !== undefined ? data.store_key : existing.store_key
    const nextKey = data.key !== undefined ? `${data.key}`.trim() : existing.key
    const nextStatus = data.status !== undefined ? data.status : existing.status

    // A conflict is only possible when the resulting tab is ACTIVE and its
    // (store_key, key) identity changes — either the key/store changed, or an
    // archived tab is being reactivated into a key an active tab already uses.
    // Icon/label/merch-only edits keep the same identity and are never blocked.
    const identityChanged =
      storeKey !== existing.store_key || nextKey !== existing.key
    const reactivating =
      nextStatus === 'active' && existing.status !== 'active'

    if (nextStatus === 'active' && (identityChanged || reactivating) && storeKey && nextKey) {
      const conflict = await repo.findByStoreAndKey(storeKey, nextKey, { activeOnly: true })
      if (conflict && conflict.id !== id) {
        throw buildConflictError(
          `An active tab with key "${nextKey}" already exists for this store. Choose a different name or key.`
        )
      }
    }

    // Same "clear before write" rule as create() — only one default per store.
    if (data.is_default === true) {
      await repo.clearDefaultsExcept(storeKey, id)
    }

    let tab
    try {
      tab = await repo.update(id, {
        ...data,
        ...(data.key !== undefined ? { key: nextKey } : {}),
        ...(data.label !== undefined ? { label: `${data.label}`.trim() } : {}),
        ...(data.image_url !== undefined
          ? { image_url: `${data.image_url || ''}`.trim() || null }
          : {}),
        ...(data.text_color !== undefined
          ? { text_color: normalizeTextColor(data.text_color) }
          : {}),
        ...(data.merch_config !== undefined
          ? { merch_config: normalizeMerchConfig(data.merch_config) }
          : {}),
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw buildConflictError(
          `An active tab with key "${nextKey}" already exists for this store. Choose a different name or key.`
        )
      }
      throw err
    }

    if (!tab) return null

    const storesToRebalance = new Set([
      existing.store_key,
      tab.store_key,
    ].filter(Boolean))

    for (const storeKeyToBalance of storesToRebalance) {
      if (tab.status === 'active' && storeKeyToBalance === tab.store_key) {
        await rebalanceStoreTabs(storeKeyToBalance, tab)
        continue
      }

      await rebalanceStoreTabs(storeKeyToBalance)
    }

    await invalidateTabCaches()
    logAdminActivity(adminId, 'UPDATE_THEME_TAB', 'theme_tab', id, null, null, ip)
    return repo.findById(tab.id)
  }

  // Uploads a new tab icon to its own Cloudinary folder (kept separate from
  // products/banners so it can be told apart in the media library), swaps
  // the tab's image_url to it, then best-effort deletes whatever the old
  // icon was — so replacing an icon never leaves an orphaned asset sitting
  // in Cloudinary storage. The delete is best-effort and runs AFTER the tab
  // already points at the new image: a failed delete must never leave the
  // tab referencing nothing, and must never fail this request — the admin's
  // actual ask (swap the icon) has already succeeded by that point.
  async updateIcon(id, fileStream, adminId, ip) {
    const existing = await repo.findById(id)
    if (!existing) return null

    const uploaded = await uploadsService.uploadImage(fileStream, {
      folder: `${env.CLOUDINARY_FOLDER}/theme-tab-icons`,
    })

    const updated = await this.update(id, { image_url: uploaded.url }, adminId, ip)

    const oldAsset = extractCloudinaryAssetInfo(existing.image_url)
    if (oldAsset?.publicId) {
      try {
        await cloudinary.uploader.destroy(oldAsset.publicId)
      } catch (err) {
        logger.warn(
          { err, tabId: id, publicId: oldAsset.publicId },
          'Failed to delete old theme tab icon from Cloudinary'
        )
      }
    }

    return updated
  }

  async archive(id, adminId, ip) {
    const tab = await repo.archive(id)
    if (!tab) return null

    await rebalanceStoreTabs(tab.store_key)
    await invalidateTabCaches()
    logAdminActivity(adminId, 'ARCHIVE_THEME_TAB', 'theme_tab', id, null, null, ip)
    return repo.findById(id)
  }

  async restore(id, adminId, ip) {
    const tab = await repo.restore(id)
    if (!tab) return null

    if (tab.status === 'active') {
      await rebalanceStoreTabs(tab.store_key, tab)

      // The restored tab may have been the store's default before it was
      // archived — reclaim that slot from whichever tab holds it now rather
      // than risk two active defaults.
      if (tab.is_default) {
        await repo.clearDefaultsExcept(tab.store_key, tab.id)
      }
    }
    await invalidateTabCaches()
    logAdminActivity(adminId, 'RESTORE_THEME_TAB', 'theme_tab', id, null, null, ip)
    return repo.findById(id)
  }
}
