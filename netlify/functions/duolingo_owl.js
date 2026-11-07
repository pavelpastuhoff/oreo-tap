/**
 * Расписание Совы ОРЕО (Netlify Scheduled Function):
 * Автоматически запускается каждые 4 часа на серверах Netlify,
 * проверяет в Firebase игроков, которые давно не заходили тапать,
 * и присылает им в Telegram пассивно-агрессивное напоминание спасти свой огонёк 🔥!
 */
const { handler: botHandler, INTERNAL_CRON_TOKEN } = require("./bot");

exports.handler = async () => {
  return botHandler({
    httpMethod: "GET",
    queryStringParameters: { action: "owl_check" },
    _internalCronToken: INTERNAL_CRON_TOKEN
  });
};
