# Deploy on Ubuntu with nginx

The configurator is static files, so nginx is all the server needs. Tested on Ubuntu 24.04 LTS.

## 1. Install nginx and open the firewall

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # ports 80 and 443
sudo ufw enable
```

After the upgrade, a reboot is only needed if `/var/run/reboot-required` exists.

## 2. Copy the files

```bash
# from your machine, in the repo folder
rsync -av --delete --exclude .git --exclude docs --exclude test ./ user@SERVER:/tmp/optimus/

# on the server
sudo mkdir -p /var/www/optimus
sudo rsync -a --delete /tmp/optimus/ /var/www/optimus/
sudo chown -R www-data:www-data /var/www/optimus
```

Or clone the repo on the server and point nginx at the clone.

## 3. nginx site

```bash
sudo tee /etc/nginx/sites-available/optimus >/dev/null <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name example.org;          # your domain, or _ for IP only
    root /var/www/optimus;
    index index.html;
    server_tokens off;
    location / { try_files $uri $uri/ =404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/optimus /etc/nginx/sites-enabled/optimus
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
curl -s localhost | grep -o '<title>.*</title>'   # → Optimus Configurator
```

If the browser still shows the nginx welcome page, the `default` site is still enabled or the browser cached it (hard reload).

## 4. Domain and HTTPS

1. At your DNS provider, add an **A** record for the domain (or subdomain) pointing to the server's public IP (`curl -4 ifconfig.me` on the server). Remove any parking/forwarding and any AAAA record that points elsewhere.
2. Wait until `dig +short example.org` returns your server IP.
3. Request the certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.org            # add -d www.example.org if wanted
sudo certbot renew --dry-run
```

Choose the HTTP → HTTPS redirect when asked. Renewal runs automatically.

**Troubleshooting:** `unauthorized … Invalid response` means DNS does not point to this server yet (check `dig`). Let's Encrypt allows about 5 failed validations per hour per name.

## 5. Updates

```bash
rsync -av --delete --exclude .git --exclude docs --exclude test ./ user@SERVER:/tmp/optimus/ \
  && ssh user@SERVER 'sudo rsync -a --delete /tmp/optimus/ /var/www/optimus/'
```

No nginx restart is needed for static files.
