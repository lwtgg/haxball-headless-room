# Deploying to an Ubuntu / Debian VPS

Why we're here: Haxball confirmed it is not publishing your room from your home
connection. `listcheck` downloaded all 1018 public rooms and yours wasn't among
them, while the direct link worked fine. That's the per-IP listing limit. A VPS
gives you a dedicated IP that nobody else's rooms are competing for.

Replace `YOUR_IP` and `USER` throughout. If you log in as root, `USER` is `root`.

---

## 1. Copy the project up (from your Windows PC)

In PowerShell, from `C:\Users\reyle\Downloads`:

```powershell
scp -r .\futsal-room_2\haxball-room USER@YOUR_IP:~/futsal
```

`scp` ships with Windows 10 and 11. If it asks about authenticity, type `yes`.

This copies your `.env` too, which is what you want. If it doesn't (some `scp`
versions skip dotfiles), send it separately:

```powershell
scp .\futsal-room_2\haxball-room\.env USER@YOUR_IP:~/futsal/.env
```

## 2. Log in and install Node 22

```bash
ssh USER@YOUR_IP
```

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # must print v22.18 or higher
```

The `apt install nodejs` in Ubuntu's own repos is too old. The NodeSource line
above is what gets you 22.

## 3. Install the project

```bash
cd ~/futsal
npm install
```

## 4. First run, in the foreground

Do this before setting up pm2, so you can see errors.

Open <https://www.haxball.com/headlesstoken> in your browser, solve the captcha,
copy the token. Then, in your SSH session:

```bash
npm run token -- PASTE_TOKEN_HERE
npm start
```

`npm run token` writes it straight into `.env` so you're not fighting an editor
while the clock runs. Tokens die in about two minutes — have the SSH session
ready and paste immediately.

You should see the config block, then `=== ROOM IS LIVE ===` with a link.

## 5. Confirm it's actually listed this time

In a second SSH session:

```bash
cd ~/futsal && npm run listcheck
```

`>>> FOUND IT. <<<` means the whole problem was your home IP and you're done.

Also check the geo line it prints. Your VPS's location is what every player
sees as the room's distance. If your VPS is somewhere far from your players,
either move it, or override with `GEO_CODE` / `GEO_LAT` / `GEO_LON` in `.env` —
though note that only changes the *displayed* distance, not the real ping.

## 6. Keep it running with pm2

Once you've seen it work in the foreground, `Ctrl+C` and switch to pm2:

```bash
sudo npm install -g pm2
pm2 start index.js --name futsal4v4
pm2 logs futsal4v4        # the room link shows here
pm2 save
pm2 startup               # run the command it prints back to you
```

Now the room survives you closing SSH, and restarts on reboot.

Useful later:

```bash
pm2 restart futsal4v4     # after a fresh token, or a code change
pm2 stop futsal4v4
pm2 logs futsal4v4 --lines 100
pm2 monit                 # live CPU and memory
```

## 7. The restart routine

Every restart needs a new token, because the token authorises creating the room.
Once it's up the token is irrelevant, so restarts are the only time it matters.

```bash
cd ~/futsal
npm run token -- PASTE_FRESH_TOKEN
pm2 restart futsal4v4
```

Restart during a quiet hour. Everyone in the room gets dropped.

---

## Notes

- **Don't run more than 2 rooms on this VPS.** Same limit that just bit you.
- **Location beats specs.** The host relays every packet between players, so
  ping is driven by distance from the VPS to your players. For a Mexico-facing
  room from a US box, Dallas or Los Angeles are the strong picks.
- **Memory is not a concern.** This is pure Node with no browser; expect
  roughly 60–100 MB. Check with `pm2 monit`.
- **Firewall.** Default Ubuntu allows all outbound, which is all this needs. No
  inbound ports to open. If you've locked down egress with ufw, allow outbound
  UDP or joins will fail while the room still starts.
- **Long uptime.** Rooms have been reported to drop off the list after a couple
  of days, after which the link gives `Connection closed (4001)`. If that
  happens, `pm2 restart` with a fresh token. Worth watching for.
