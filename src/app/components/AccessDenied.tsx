export default function AccessDenied() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="hazard w-24 rise" />
      <h1 className="font-sign text-2xl font-extrabold tracking-tight rise" style={{ animationDelay: "60ms" }}>
        Private garage
      </h1>
      <p className="text-sm leading-relaxed text-hint rise" style={{ animationDelay: "120ms" }}>
        This app is for one family's shared car. If that's you, message the bot with /start and
        send your Telegram id to the admin.
      </p>
      <div className="hazard w-24 rise" style={{ animationDelay: "180ms" }} />
    </div>
  );
}
