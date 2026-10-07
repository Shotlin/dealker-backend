const uuidPattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export const bannerIdSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: uuidPattern } },
  },
};

export const createBannerSchema = {
  body: {
    type: "object",
    required: ["title", "imageUrl"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      imageUrl: { type: "string", format: "uri" },
      bannerType: {
        type: "string",
        enum: [
          "carousel",
          "popup",
          "announcement",
          "category",
          "category_footer",
        ],
        default: "carousel",
      },
      linkType: {
        type: "string",
        enum: ["category", "product", "url", "none"],
        default: "none",
      },
      linkValue: { type: "string", maxLength: 500 },
      isActive: { type: "boolean", default: true },
      startDate: { type: "string", format: "date-time" },
      endDate: { type: "string", format: "date-time" },
      triggerType: {
        type: "string",
        enum: ["ALWAYS", "STORE_CLOSED"],
        default: "ALWAYS",
      },
      shopId: { type: "string", pattern: uuidPattern },
    },
  },
};

export const updateBannerSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: uuidPattern } },
  },
  body: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      imageUrl: { type: "string", format: "uri" },
      bannerType: {
        type: "string",
        enum: [
          "carousel",
          "popup",
          "announcement",
          "category",
          "category_footer",
        ],
      },
      linkType: {
        type: "string",
        enum: ["category", "product", "url", "none"],
      },
      linkValue: { type: "string", maxLength: 500 },
      isActive: { type: "boolean" },
      startDate: { type: ["string", "null"], format: "date-time" },
      endDate: { type: ["string", "null"], format: "date-time" },
      triggerType: { type: "string", enum: ["ALWAYS", "STORE_CLOSED"] },
      shopId: { type: ["string", "null"], pattern: uuidPattern },
    },
  },
};

export const reorderSchema = {
  body: {
    type: "object",
    required: ["orderedIds"],
    properties: {
      orderedIds: {
        type: "array",
        minItems: 1,
        items: { type: "string", pattern: uuidPattern },
      },
    },
  },
};
