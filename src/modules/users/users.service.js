import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { buildCloudinaryUrl, normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { uploadImageWithCloudinaryFallback } from '../../utils/cloudinary-upload.js'

/**
 * Users service — business logic for user management
 */
export class UsersService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Get user profile
   */
  async getProfile(userId) {
    const user = await this.repo.findById(userId)
    if (!user) return null
    return this._normalizeUserMedia(user)
  }

  /**
   * Update user profile (name, email, birthday)
   */
  async updateProfile(userId, data) {
    // Check email uniqueness if email is being updated
    if (data.email) {
      const taken = await this.repo.isEmailTaken(data.email, userId)
      if (taken) {
        return { success: false, message: 'Email is already in use' }
      }
    }

    const updated = await this.repo.updateProfile(userId, data)
    return { success: true, user: this._normalizeUserMedia(updated) }
  }

  /**
   * Upload avatar to Cloudinary and update user
   */
  async uploadAvatar(userId, fileStream) {
    try {
      const result = await uploadImageWithCloudinaryFallback(fileStream, {
        folder: `${env.CLOUDINARY_FOLDER}/avatars`,
        public_id: `user_${userId}`,
        overwrite: true,
        transformation: [
          { width: 300, height: 300, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      })

      const avatarUrl = buildCloudinaryUrl(
        {
          publicId: result.public_id,
          version: result.version,
        },
        'default'
      )

      const user = await this.repo.updateAvatar(userId, avatarUrl)
      return { success: true, avatar_url: this._normalizeUserMedia(user).avatar_url }
    } catch (error) {
      logger.error({ err: error }, 'Avatar upload to Cloudinary failed')
      throw error
    }
  }

  /**
   * Get user stats
   */
  async getStats(userId) {
    return this.repo.getStats(userId)
  }

  _normalizeUserMedia(user) {
    if (!user) return user

    return {
      ...user,
      avatar_url: normalizeCloudinaryDeliveryUrl(user.avatar_url, 'default'),
    }
  }
}
