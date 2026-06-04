/**
 * TC-4e — NON-SECRET test cert fixtures for the cloud-publisher wire-level
 * mTLS tests. A throwaway PKI (self-signed CA → server cert for localhost →
 * client cert CN=cortex-cloud-publisher) used ONLY by an in-process loopback
 * `node:https` server in the cloud-publisher test suite. These authenticate
 * nothing real; they exist so a test can stand up a `requestCert: true,
 * rejectUnauthorized: true` server and assert that the cloud-publisher's POST
 * actually PRESENTS the client cert on the wire (not merely that `init.tls`
 * was attached). Regenerate freely — no trust is vested in them.
 *
 * Why baked PEMs and not runtime generation: `node:crypto` has no X.509
 * signing API, and adding a cert-gen dependency (`selfsigned` / `node-forge`)
 * for a test fixture violates the "no heavy deps" rule. Baked fixtures are
 * deterministic and CI-safe (no openssl shell-out).
 */

/** Self-signed test CA. Verifies both the server and client certs below. */
export const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUcb3x86ld52C+Zw3WJgIJdXOzlNQwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIQ1BUZXN0Q0EwIBcNMjYwNjA0MTEzNDEyWhgPMjEyNjA1
MTExMTM0MTJaMBMxETAPBgNVBAMMCENQVGVzdENBMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAuHRcCoD1QOPpjChd8iVjUx0SjOHoVYDW0dDofi3alCTr
ZtlvEiJY0XHm6jsQYDNUf9SEY+3d+fS840FmX2l6x+Yhy9fwl4uvmlNcUeDUARAx
w2cns9D7AwK5oZ3cFT5aRpf2TE1MNPaS2mCHZihir0xAeuQdtpgk5O7tSe7/OyZU
2lii8z0C9jYrDSxgLgSYyvVIZ543v2d9reAvAC22JpHmOaRI6afly5chDSAtGAKs
vaUCb5mvBbIHpBvtGxwru3etEho6Lrs6EkcS4JhfyMlNFqGal7jKeiBz2dgHnUOR
PJiPkT8WQZ92qQ5uOrU9FouMUMt+KKCle9Yiwztq3QIDAQABo1MwUTAdBgNVHQ4E
FgQUlK08kX57sCxwUROZvtwvzj1PAREwHwYDVR0jBBgwFoAUlK08kX57sCxwUROZ
vtwvzj1PAREwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnHS4
FLZjm8PVzNAGPx1F/TGYGGhGH/2MXnnqW941/qlaHn1pX81XLN3tKG1moPU8z9/b
SqLwVGmyI5Zkta1XJk1+phIfLJn8DMIRa9LW1Gev3DcMT5oV3b+yhRbSleMUiVQG
T2BX+83ztwqlc37kZpKrpaFIELyu4AlP7V9L7ML1OZptDVlLiEslfHcE7wH31iJm
Cs3oEehGRZyZfK9vteQuJy44G0u6PuhBzsV5aEHYDM7Nx4FqN6+iyyP24Kk1xSo6
6HmhlV8VjnUYXZ65mDXgOHseZ8ejX3d5s7bPUWc06L/o+fh1wnOhpFBzGuvI7vaG
tvx/Ozan0/+Deg86ww==
-----END CERTIFICATE-----
`;

/** Loopback server cert (CN=localhost, SAN localhost/127.0.0.1). */
export const TEST_SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUPjG0PqLe8LO/QXtIYlaA1xbFtZMwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIQ1BUZXN0Q0EwIBcNMjYwNjA0MTEzNDEyWhgPMjEyNjA1
MTExMTM0MTJaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBALEStUPwLVEYES8oMVaQossKVM4OO6TP0u/Swc11uj5k
hlG7TuBO1nJuq5Do+Q+3kvXzhhMULqZrHimMbuKmccYzFWIR5/H67XvqM+gIqEtU
0zGonv5Kg5WRNicDi6UDaKsj6HidtyCI1njnGy69YN7xjOSJzqfmPhBdJlnx1BeZ
93yFfIfb91PtPJ7tGZZ3bDo2rqtVxuIeIDYMi0rhWgqinvbH9EnRzS9ROKeloqbF
enXjZ0M2FSiwJU+SnAsOOlsFueRDPt0tFOb89fAHLoGGWxZ/sFS383+0SbwPH2Ad
fURLdv+aFksXlo9SrU3HvU0XKbX9EzsH7nvSNMTmpy0CAwEAAaNeMFwwGgYDVR0R
BBMwEYIJbG9jYWxob3N0hwR/AAABMB0GA1UdDgQWBBSWoYiXlkJRmCBlVDcus4vz
t0zthDAfBgNVHSMEGDAWgBSUrTyRfnuwLHBRE5m+3C/OPU8BETANBgkqhkiG9w0B
AQsFAAOCAQEAOzsF50IIe3Id1qAJfj5jWp9pVfXLl3vHvq5jEyyloFOE0ZCtuDiD
A0JWMwvv8XwPaRZXdxJpO08INmJcHQHnNQByC3wv287n7Tw/NnuIRQobgzs7R2dC
sL4WH/CgbshInkbdZa5rFa40d8Sr39mIAclztdV0bYVWIuefvBjPHDrzL/wL32US
xDBx1rrcGUkE3rhbAxFlBY4F1plhN60XZKWOChD+66Y50ETBO0DH0JEOk3zrylBJ
X0e/x0wuSMp8hevaN2c8lVh2xW9T4keHsZV7wlQqRD6GN5MZcBH+nVEW88igSBD8
9dMHv0wravqPyySxQg0W/va9XKGw24HJ/A==
-----END CERTIFICATE-----
`;

/** Private key for {@link TEST_SERVER_CERT}. NON-SECRET fixture. */
export const TEST_SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCxErVD8C1RGBEv
KDFWkKLLClTODjukz9Lv0sHNdbo+ZIZRu07gTtZybquQ6PkPt5L184YTFC6max4p
jG7ipnHGMxViEefx+u176jPoCKhLVNMxqJ7+SoOVkTYnA4ulA2irI+h4nbcgiNZ4
5xsuvWDe8Yzkic6n5j4QXSZZ8dQXmfd8hXyH2/dT7Tye7RmWd2w6Nq6rVcbiHiA2
DItK4VoKop72x/RJ0c0vUTinpaKmxXp142dDNhUosCVPkpwLDjpbBbnkQz7dLRTm
/PXwBy6BhlsWf7BUt/N/tEm8Dx9gHX1ES3b/mhZLF5aPUq1Nx71NFym1/RM7B+57
0jTE5qctAgMBAAECggEAPucHb3/1iTZEfH0JsdeljP05jQ1vUKfnJfy3jfZBWAK7
2HLynSpEcdgwqESqnVO4KBj/Su3DeKjaySWzCl7YUfE5qmH0BHkAPiG/mLDioAgd
Ein1eR4dSleQZiGTTOY+G3WhEp/sOumBTufCN0NdEzW5uEHgILLg301H33HRxyP4
k5NUktpjMUOcaZzNrhH9VNqyUpX7bjrm5sZE4+Rnjlv/Kv21fc6k8X7/2GIc/31y
R5QjsTN/ZmYBbH7n9kba6J6go2CcqNe0GEZVrb/SxDEZUcNWlBFt/wSmp29Yo7VC
XYAlkeRj1WfEGJEuaLFJXshL7Bvqx8gOg6yF+NZQPQKBgQD6H9YS2xKxmPdqvrfq
2LmweDi54OlZmBlusaSgZ3pf2sJfC+y7HnyIjJkml+98u5Ed++gFC9+bxcp3c2ou
G+gmhPSNM0qoGJrwbZs86dWy27ZijbAyoDXxVBPt2hEM4+0LfpPJJnyJ5IXFe4yv
9r9FXq3ftyEUNEiMtQ8HUy6wRwKBgQC1O5DlocHv/2QdOsToxkF5Ilm3dmCHadv+
1ZPDPA98ykm6uM2xXKNX1VALNOPHF8RNd2/wcmVNINE01N0n+ZuoGi6WFrnjiZ3o
sxtCo6x9mAZXRGsosJqpN9YAX1NvHZdKQUkzWem/te7LTPYFUxPs++KZ5lFepAP2
GDtm1C966wKBgQCn4riY/WzFwivH/W2Ld57jwT4qHbnjRkFD2H7sn6g3MKmojGOA
kYz7RowBqJe5/FgCbTQmNvsHHrKwjMpnWpnvSOyw3g2tWJ6e5KL/NuEWZX09F2d+
A6VRb6LU0rsBEPfp8DMYH/oVwEq97BjZf2CRGmTQtaXBXvqXX2xP+VhsPwKBgCbz
5JLWj56L3/LAXO5DHnNwxKPAF8NDJ3vAYAAIerOxruMpMVy7sogAWzHtbj+uhgy4
bSDbFZbcRNr8HYSoC6K37edofw++1mfbhzJth3d/I23CUN3wB23ziFWQJ5isXYYi
Ph+BZdJEwkyEACTo1FGNWgkGDdsvmYJddvcFCCd9AoGATcDGhbw0zo3zP2wD3/b7
e2HD6IOQ27IBE/ng/NlPnFhwpTWIEz66Mir3j+8+tTEMMwpalZP5qCO/1ltxtggm
7RpJP5pA0FYfEihTJ330tOzKH0c3iqi+LI9s4CZvlTVOqXWiRNi/RJ8eKNHrCoqS
yP86qI4I4NiLJNkc8kvL41c=
-----END PRIVATE KEY-----
`;

/** Client cert (CN=cortex-cloud-publisher). The CN the server should observe. */
export const TEST_CLIENT_CERT = `-----BEGIN CERTIFICATE-----
MIICvTCCAaUCFD4xtD6i3vCzv0F7SGJWgNcWxbWUMA0GCSqGSIb3DQEBCwUAMBMx
ETAPBgNVBAMMCENQVGVzdENBMCAXDTI2MDYwNDExMzQxMloYDzIxMjYwNTExMTEz
NDEyWjAhMR8wHQYDVQQDDBZjb3J0ZXgtY2xvdWQtcHVibGlzaGVyMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmvyjpbdN7+anmGuFNHh25A5a1LoMiNfq
MczMtRkCSDB+7s3b5CsyrV89VVfgWA4N8ox66DVqwrY3cTvNK8212KfNmuhWdfTF
/p4R/R+ESAbvNtS542cd286X+hQ8M+YXFBwybufMLwba5BlkJgW/JUdgbydOr1B7
JBa1cHm0/WuJ2EbZiYhPdlrKqrY4Ff2/cTN126iM/ule7+msHkEaKvSlGyzagPW8
Y/zsXoko3HIvtZ2/rfjEmkqkMQuCI9NHyKVx3B1bXi7V/9YrSQeEL0k3EP4wW/Zm
k+7+YYHv1+4ToiePL3QC1Crqj7Xs2OhRoe+/yBbUynIsh/bQFTms6QIDAQABMA0G
CSqGSIb3DQEBCwUAA4IBAQCzNovzVBlVAopCAb5NVtnZNNyK8D+koraL8b3BMcub
G2QGbilW5yrmHZyWfSHax/xTwkriAJ6ef2+KopSyS1DPebG40k/GZXqChpZREEkI
kXr0U6ShKMueLu4CQbmp+ZXEmDwBFe/sLK9KpPJuaJtlry5XA5ZjA0sKXJGVpE7l
o/NDTKguFNusuWztocuoAX+aEhtgZ90X5WCbtusyUABTdjq4bZCyRIh3NDKeUb4q
RO4w6gO6oAFx40w5upUBL7QPc+S49+BLMqboy+uNNzRoI4kEPXzAgDrjEh5f/YYk
OqKYlu7r9D74cM2TTy1ufufrtNFAoYrC0BFFucfAWent
-----END CERTIFICATE-----
`;

/** Private key for {@link TEST_CLIENT_CERT}. NON-SECRET fixture. */
export const TEST_CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCa/KOlt03v5qeY
a4U0eHbkDlrUugyI1+oxzMy1GQJIMH7uzdvkKzKtXz1VV+BYDg3yjHroNWrCtjdx
O80rzbXYp82a6FZ19MX+nhH9H4RIBu821LnjZx3bzpf6FDwz5hcUHDJu58wvBtrk
GWQmBb8lR2BvJ06vUHskFrVwebT9a4nYRtmJiE92WsqqtjgV/b9xM3XbqIz+6V7v
6aweQRoq9KUbLNqA9bxj/OxeiSjcci+1nb+t+MSaSqQxC4Ij00fIpXHcHVteLtX/
1itJB4QvSTcQ/jBb9maT7v5hge/X7hOiJ48vdALUKuqPtezY6FGh77/IFtTKciyH
9tAVOazpAgMBAAECggEAAtNWMpju3wUTWzONnNfmjKXoLm6QYy/IMB18ghTemOfn
w9farrRCEvf/J3bH9c8Bc9baDZueB/FNaDSdBakKdp9TinkPzMwi48S9uExvwNDo
jEqQnivUzGYIg67aAfULnhUdWcPYfKcpNy/xJpd4+peMfhDx7dS0/q16eWkXSBNG
LpwbLMIAUM2br5geXtD7h1nwTuYC00ZzuO/n04OT3dfFDVixXVxhgu8tHR9BoNrx
jbtvvu30vP+T94f9U3COe7GvUy9aYK2Qvd7DQaWNpB/G8Tsz7yvE5kY146rvPKCW
15DTp/0P7gcMnpneTgvFERT5gQXK3dASI5SE4aa4sQKBgQDNXaMnUkYKM6BGTXJK
st+DznLDJwrSALD9yRGMEdw36re5dk7YoyrQRA1mpi7dfPU3SGj2dPRLDPiJ5ew7
IECNpT9336R0ECrIzN3XvMiLEiEaeRyoPmLpr6FLwXka3m71RXK8a3hvc+j4Vbkt
5dfAC53eAO74dB11XW+SpL/aEQKBgQDBMype/qogvCbfxpKvgXxYeM8JkhQAHvO3
sXaIyW49H+G8/XUNqof3NTSoFxErBaklYlx5Xe9FfKXFYtWZ94TsdEzgeN4YBCbe
Yy/vr1GdZeGBsm1tkuwLOYnzd0OWWhGAsZJuXoSYwgvnCOWUuy34VNg5dz5PiObM
waqFdTQNWQKBgQCDSnvF5blVSFAM4fJRgy2WLGP+E3W9cCe299a5/6kULoCqltIt
eZMjdn5Cw7dubjau0yIXfgm3+WDjeBSgcCwU4jJDRrzyXmub2C1zgQOMtVhofkkt
3kSKNXge4F+2J8I0F+QURXjHeAjWyqcKish1xHd2uI4OVN2IbOWpkJ3+oQKBgFpX
B4gWAw19jZvz6aFhpfhkvUMXaHzJ/GK3+9pofkDcyJyr0/FI/X0OBwpWhvOcGQTf
Iqip0PmoGIfc+E6fnCtJEq2gNxH51wcEUGT+kOZNvo38Fgk3u2JgTG5pJVSH10lb
P0KWteAMVK56zYenow5M9jKg3KUqOeoi4Q64yFc5AoGBAIYAjMDcx3BWDh7Sorf+
NTTi4lazmuIO2qI916lvFFzg00RmJ2VQ+J8+dmoJ5Wj2DV4CpeOSwxqvzCK2KSKE
Tdl21sJYZXK090DRv0ghncGfQlS/woTYStzqUG+P1XOPe5kg+923TZ44+SaHY8ht
vukjXVw2rRT4wa5rJ2muzYO1
-----END PRIVATE KEY-----
`;

/** The CN baked into {@link TEST_CLIENT_CERT}; what a wire test asserts. */
export const TEST_CLIENT_CN = "cortex-cloud-publisher";
