#!/usr/bin/env python3
"""
get_rent_engine_code.py — Read the Rent Engine 6-digit login code from Gmail via IMAP.
Polls up to 60 seconds for the email to arrive.

Usage: GMAIL_ADDRESS=... GMAIL_APP_PASSWORD=... python3 get_rent_engine_code.py
Output: prints the 6-digit code to stdout, exits 0
        prints "ERROR: ..." to stdout, exits 1 on failure
"""

import imaplib
import email
import os
import re
import sys
import time

user = os.environ.get('GMAIL_ADDRESS', '')
password = os.environ.get('GMAIL_APP_PASSWORD', '')

if not user or not password:
    print('ERROR: GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set')
    sys.exit(1)

for attempt in range(12):  # 12 x 5s = 60 seconds
    try:
        mail = imaplib.IMAP4_SSL('imap.gmail.com', 993)
        mail.login(user, password)
        mail.select('INBOX')

        # Try unseen first, fall back to recent
        _, uids = mail.search(None, '(UNSEEN FROM "rentengine")')
        if not uids[0]:
            _, uids = mail.search(None, '(FROM "rentengine" SUBJECT "code")')
        if not uids[0]:
            _, uids = mail.search(None, '(FROM "rentengine")')

        if uids[0]:
            uid = uids[0].split()[-1]  # most recent
            _, md = mail.fetch(uid, '(RFC822)')
            for part in md:
                if isinstance(part, tuple):
                    msg = email.message_from_bytes(part[1])
                    body = ''
                    if msg.is_multipart():
                        for m in msg.walk():
                            ct = m.get_content_type()
                            payload = m.get_payload(decode=True)
                            if payload and ct in ('text/plain', 'text/html'):
                                body += payload.decode('utf-8', errors='ignore')
                    else:
                        payload = msg.get_payload(decode=True)
                        if payload:
                            body = payload.decode('utf-8', errors='ignore')

                    codes = re.findall(r'\b(\d{6})\b', body)
                    if codes:
                        mail.logout()
                        print(codes[0])
                        sys.exit(0)

        mail.logout()

    except Exception as e:
        pass  # retry on IMAP errors

    if attempt < 11:
        time.sleep(5)

print('ERROR: No Rent Engine login code found after 60 seconds')
sys.exit(1)
