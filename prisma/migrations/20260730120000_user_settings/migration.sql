-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "work_minutes" SMALLINT NOT NULL DEFAULT 25,
    "break_minutes" SMALLINT NOT NULL DEFAULT 5,
    "theme" VARCHAR(16) NOT NULL DEFAULT 'system',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
