import type { Request, Response } from "express"
import prisma from "../lib/prisma.js"
import config from "../config.js"
import { readCartReminderStopLink } from "../lib/cartReminders.js"
import { escapeHtml } from "../lib/sharePages.js"

// A small plain page for links opened from an email (there is no app page behind them).
function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · StoreHatch</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f6f4;color:#1f2328}
main{max-width:440px;margin:15vh auto 0;padding:32px 24px;background:#fff;border:1px solid #e3e3e0;border-radius:12px}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;margin:0 0 16px}
button{font:inherit;background:#174B3A;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
a{color:#174B3A}
</style>
</head>
<body><main>${body}</main></body>
</html>`
}

function sendInvalid(res: Response) {
    res.status(400).type("html").send(page("Link not valid", `<h1>This link is not valid</h1><p>It may have been copied incompletely. You can switch cart reminders off in your account settings on <a href="${escapeHtml(config.frontendUrl)}">StoreHatch</a>.</p>`))
}

// Opening the link only shows a button: mail apps and link scanners open links on their own, and that must not
// switch anything off. Pressing the button sends the form back to this same address.
export const showStopCartReminders = (req: Request, res: Response) => {
    if (readCartReminderStopLink(req.query.u, req.query.t) === null) {
        sendInvalid(res)
        return
    }

    res.set("Cache-Control", "no-store").type("html").send(page("Stop cart reminders", `<h1>Stop cart reminders?</h1><p>You will no longer get an email when you leave something in your StoreHatch cart. Order emails are not affected.</p><form method="post"><button type="submit">Stop cart reminders</button></form>`))
}

export const stopCartReminders = async (req: Request, res: Response) => {
    const userId = readCartReminderStopLink(req.query.u, req.query.t)

    if (userId === null) {
        sendInvalid(res)
        return
    }

    await prisma.user.updateMany({ where: { id: userId }, data: { cartRemindersOff: true } })
    res.set("Cache-Control", "no-store").type("html").send(page("Cart reminders stopped", `<h1>Done</h1><p>You will not get cart reminders any more. You can switch them back on in your account settings on <a href="${escapeHtml(config.frontendUrl)}">StoreHatch</a>.</p>`))
}
