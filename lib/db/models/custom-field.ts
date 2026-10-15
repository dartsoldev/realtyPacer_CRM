import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from "@/lib/domain/constants";

const optionSchema = new Schema(
  {
    value: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 80 },
  },
  { _id: false },
);

const customFieldDefinitionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    entityType: { type: String, enum: CUSTOM_FIELD_ENTITIES, required: true },
    /** Stable machine key, e.g. "pet_type". Never contains "$" or ".". */
    key: { type: String, required: true, match: /^[a-z][a-z0-9_]{0,39}$/ },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    dataType: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    options: { type: [optionSchema], default: [] },
    filterable: { type: Boolean, default: false },
    showInTable: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

customFieldDefinitionSchema.pre("validate", function () {
  const needsOptions = this.dataType === "select" || this.dataType === "multi_select";
  if (needsOptions && this.options.length === 0) this.invalidate("options", "Select fields need at least one option");
  if (!needsOptions && this.options.length > 0) this.invalidate("options", "Only select fields may have options");
});

customFieldDefinitionSchema.index({ organizationId: 1, entityType: 1, key: 1 }, { unique: true });
customFieldDefinitionSchema.index({ organizationId: 1, entityType: 1, active: 1, order: 1 });

export type CustomFieldDefinitionDoc = InferSchemaType<typeof customFieldDefinitionSchema> & { _id: Types.ObjectId };

export const CustomFieldDefinition: Model<InferSchemaType<typeof customFieldDefinitionSchema>> =
  models.CustomFieldDefinition || model("CustomFieldDefinition", customFieldDefinitionSchema);
