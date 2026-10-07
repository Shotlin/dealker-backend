import { AdminBannersService } from "../admin/banners/banners.service.js";
import { AllocationRepository } from "../allocation/allocation.repository.js";
import { AllocationService } from "../allocation/allocation.service.js";
import { success } from "../../utils/apiResponse.js";

const svc = new AdminBannersService();
const allocationService = new AllocationService(new AllocationRepository());

async function resolveStorefrontShopId(request, fastify) {
  const user = request.user;
  if (user?.id && (!user.role || user.role === "CUSTOMER")) {
    const allocation = await allocationService.getForUser(user.id);
    return allocation?.shops?.find((shop) => shop.is_primary)?.shop_id || null;
  }

  const token = request.headers?.["x-storefront-token"];
  if (!token || typeof token !== "string") return null;
  try {
    const payload = await fastify.jwt.verify(token);
    if (
      payload?.scope !== "guest-storefront" ||
      !Array.isArray(payload.shopIds)
    )
      return null;
    return payload.shopIds.find((shopId) => typeof shopId === "string") || null;
  } catch {
    return null;
  }
}

export default async function bannerRoutes(fastify) {
  fastify.get(
    "/",
    {
      preHandler: async (request) => {
        if (typeof fastify.optionalAuth === "function") {
          try {
            await fastify.optionalAuth(request);
          } catch {
            /* guest request */
          }
        }
      },
    },
    async (request, reply) => {
      const { type } = request.query;
      const shopId = await resolveStorefrontShopId(request, fastify);
      // Banners are storefront content too: without a resolved location they
      // must not expose an all-store promotion feed.
      if (!shopId) return success([], "Active banners fetched");
      const banners = await svc.getActiveForStoreStatus(type, shopId);
      return success(banners, "Active banners fetched");
    },
  );
}
