import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_VISIBILITIES } from "@/lib/domain/constants";

const optionSchema = new Schema(
  {
    /** Generated, stable stored value (e.g. "o_k3j9"); labels can be renamed freely. */
    value: { type: String, required: true, match: /^o_[a-z0-9]{4,12}$/ },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    archived: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * Admin-defined extra field. Values live in `<entity>.customFields[key]`.
 * `key` is generated server-side (`cf_` + random), so it can never be a dotted
 * path, `$`-operator or system field name.
 */
const customFieldDefinitionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    entityType: { type: String, enum: CUSTOM_FIELD_ENTITIES, required: true },
    key: { type: String, required: true, match: /^cf_[a-z0-9]{8}$/ },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    dataType: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    options: { type: [optionSchema], default: [] },
    validation: {
      type: new Schema(
        {
          maxLength: { type: Number, min: 1, max: 5000, default: null },
          min: { type: Number, default: null },
          max: { type: Number, default: null },
          integer: { type: Boolean, default: false },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    showInTable: { type: Boolean, default: false },
    filterable: { type: Boolean, default: false },
    /** Opt-in database index for frequently filtered fields (bounded per entity; see db:indexes). */
    indexed: { type: Boolean, default: false },
    visibility: { type: String, enum: CUSTOM_FIELD_VISIBILITIES, default: "office" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

customFieldDefinitionSchema.index({ organizationId: 1, entityType: 1, key: 1 }, { unique: true });
customFieldDefinitionSchema.index({ organizationId: 1, entityType: 1, archivedAt: 1, order: 1 });

export type CustomFieldDefinitionDoc = InferSchemaType<typeof customFieldDefinitionSchema> & { _id: Types.ObjectId };

export const CustomFieldDefinition = (models.CustomFieldDefinition || model("CustomFieldDefinition", customFieldDefinitionSchema)) as Model<
  InferSchemaType<typeof customFieldDefinitionSchema>
>;
