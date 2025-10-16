import pyotp

totp_secret = "YEGAMEM5RFLC6OB7B2VXF53J3H2SY7CS"
totp = pyotp.TOTP(totp_secret)

print("=" * 50)
print("  TOTP Code Validator")
print("=" * 50)
print(f"\nCurrent TOTP Code: {totp.now()}")
print("\nOpen your Google Authenticator app and compare!")
print("If they match → Ready to test token refresh")
print("If they don't match → TOTP setup incomplete")
print("=" * 50)
