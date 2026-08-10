import json
import os
import smtplib
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from email.message import EmailMessage
from zoneinfo import ZoneInfo


FALLBACK_FIREBASE_API_KEY = "AIzaSyBc4gpU-v6KybqHcj2zDlA5MLqClOxO6Yc"


def firestore_value(value):
    if "stringValue" in value:
        return value["stringValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "booleanValue" in value:
        return bool(value["booleanValue"])
    if "nullValue" in value:
        return None
    if "arrayValue" in value:
        return [firestore_value(item) for item in value["arrayValue"].get("values", [])]
    if "mapValue" in value:
        return {
            key: firestore_value(item)
            for key, item in value["mapValue"].get("fields", {}).items()
        }
    if "timestampValue" in value:
        return value["timestampValue"]
    return None


def firestore_document_to_dict(document):
    return {
        key: firestore_value(value)
        for key, value in document.get("fields", {}).items()
    }


def fetch_state():
    project_id = os.environ["FIREBASE_PROJECT_ID"]
    api_key = os.environ.get("FIREBASE_API_KEY") or FALLBACK_FIREBASE_API_KEY
    document_path = urllib.parse.quote("(default)", safe="")
    url = (
        f"https://firestore.googleapis.com/v1/projects/{project_id}"
        f"/databases/{document_path}/documents/app/state?key={api_key}"
    )
    with urllib.request.urlopen(url, timeout=30) as response:
        return firestore_document_to_dict(json.load(response))


def mark_email_sent(today):
    project_id = os.environ["FIREBASE_PROJECT_ID"]
    api_key = os.environ.get("FIREBASE_API_KEY") or FALLBACK_FIREBASE_API_KEY
    document_path = urllib.parse.quote("(default)", safe="")
    url = (
        f"https://firestore.googleapis.com/v1/projects/{project_id}"
        f"/databases/{document_path}/documents/app/state"
        f"?key={api_key}&updateMask.fieldPaths=emailLastSentDate"
    )
    body = json.dumps({
        "fields": {
            "emailLastSentDate": {"stringValue": today}
        }
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="PATCH",
    )
    with urllib.request.urlopen(request, timeout=30):
        return


def segment_label(paper, segment):
    end_page = segment.get("endPage") or "end"
    return f"{paper.get('title', 'Untitled paper')} p{segment.get('startPage')}-{end_page}"


def due_items(state, today):
    items = []
    for paper in state.get("papers", []):
        segments = {
            segment.get("id"): segment
            for segment in paper.get("segments", [])
        }
        for review in paper.get("reviews", []):
            if review.get("completedAt"):
                continue
            due_date = review.get("dueDate")
            if due_date and due_date <= today:
                segment = segments.get(review.get("segmentId"), {})
                items.append({
                    "paper": paper,
                    "segment": segment,
                    "review": review,
                })
    return sorted(items, key=lambda item: item["review"].get("dueDate", ""))


def format_email(items, today):
    lines = [
        f"Paper Revisit due list for {today}",
        "",
        "Due or overdue reviews:",
        "",
    ]
    for item in items:
        paper = item["paper"]
        review = item["review"]
        due_date = review.get("dueDate")
        step = review.get("step", 0)
        authors = paper.get("authors") or "No authors listed"
        lines.append(f"- {segment_label(paper, item['segment'])}")
        lines.append(f"  Due: {due_date} | Step: {step + 1} | {authors}")
    lines.append("")
    lines.append("Open the website to reconstruct the ideas before rereading.")
    return "\n".join(lines)


def send_email(subject, body):
    host = os.environ["EMAIL_SMTP_HOST"]
    port = int(os.environ.get("EMAIL_SMTP_PORT", "587"))
    username = os.environ["EMAIL_SMTP_USERNAME"]
    password = os.environ["EMAIL_SMTP_PASSWORD"]
    sender = os.environ.get("EMAIL_FROM") or username
    recipient = os.environ["EMAIL_TO"]

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.set_content(body)

    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(username, password)
        smtp.send_message(message)


def main():
    timezone = ZoneInfo(os.environ.get("TIMEZONE", "Australia/Sydney"))
    now = datetime.now(timezone)

    today = now.date().isoformat()
    state = fetch_state()
    settings = state.get("settings") or {}
    if settings.get("emailReminders") is False:
        print("Skipping: email reminders are disabled.")
        return
    if state.get("emailLastSentDate") == today:
        print(f"Skipping: reminder email already sent for {today}.")
        return
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule" and now.hour < 9:
        print(f"Skipping: local time is {now:%H:%M}, before 9am.")
        return

    items = due_items(state, today)
    if not items:
        print(f"No due reviews for {today}.")
        return

    subject = f"Paper reviews due today ({len(items)})"
    send_email(subject, format_email(items, today))
    mark_email_sent(today)
    print(f"Sent due review email with {len(items)} item(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Failed to send due review email: {exc}", file=sys.stderr)
        raise
