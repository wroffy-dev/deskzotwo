-- CreateTable
CREATE TABLE "chat_icons" (
    "chatId" TEXT NOT NULL,
    "dataUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "setById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_icons_pkey" PRIMARY KEY ("chatId")
);

-- AddForeignKey
ALTER TABLE "chat_icons" ADD CONSTRAINT "chat_icons_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
