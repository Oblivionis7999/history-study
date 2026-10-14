import getpass
import secrets
from argon2 import PasswordHasher

if __name__=='__main__':
    password=getpass.getpass('访问密码（至少8位）：')
    if len(password)<8:
        raise SystemExit('密码至少8位。')
    if password!=getpass.getpass('再次输入：'):
        raise SystemExit('两次密码不一致。')
    print("ACCESS_PASSWORD_HASH='"+PasswordHasher().hash(password)+"'")
    print('SESSION_SECRET='+secrets.token_urlsafe(48))
