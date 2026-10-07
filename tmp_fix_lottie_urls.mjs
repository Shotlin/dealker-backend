import fs from 'node:fs/promises'
import pg from 'pg'
import dotenv from 'dotenv'
import { v2 as cloudinary } from 'cloudinary'
import { cacheDeletePattern } from './src/utils/cache.js'

dotenv.config({ path: './.env' })

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
})

const uploads = [
  {
    tab: 'all',
    file: '../bakaloo_customer/assets/lottie/summer_banner.lottie',
    filename: 'summer_banner.lottie',
  },
  {
    tab: 'navratri',
    file: '../bakaloo_customer/assets/lottie/puja.lottie',
    filename: 'puja.lottie',
  },
]

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

await client.connect()

try {
  for (const item of uploads) {
    const buffer = await fs.readFile(item.file)
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: 'bakaloo/theme-assets',
          public_id: item.filename,
        },
        (err, res) => (err ? reject(err) : resolve(res))
      )
      stream.end(buffer)
    })

    await client.query(
      `UPDATE section_manifests sm
       SET config = jsonb_set(sm.config, '{lottie_url}', to_jsonb($1::text), true)
       FROM theme_tabs tt
       WHERE tt.id = sm.tab_id
         AND tt.store_key = 'zepto'
         AND tt.key = $2
         AND sm.section_type = 'animated_banner'`,
      [result.secure_url, item.tab]
    )

    console.log(JSON.stringify({ tab: item.tab, url: result.secure_url }))
  }

  await cacheDeletePattern('bakaloo:sections:*')
  await cacheDeletePattern('bakaloo:theme:*')
} finally {
  await client.end()
}
