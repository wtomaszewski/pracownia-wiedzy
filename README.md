# Pracownia wiedzy

Domowy portal do nauki dla ucznia klasy 4. Polski interfejs, quizy z podpowiedziami, historia wyników i ćwiczenie pojedynczych błędów. Jeden wspólny profil dziecka, dostępny na komputerze, tablecie i telefonie.

Repozytorium zawiera kod, pytania i autorskie rysunki. **Nie zawiera historii dziecka, jego profilu, odpowiedzi, eksportów ani kopii bazy.** Przy pierwszym uruchomieniu powstaje nowa, pusta baza i profil „Odkrywca”. Funkcja zapisywania wyników pozostaje dostępna.

## Co jest w środku

| Przedmiot | Zagadnienia | Gotowe zestawy | Pytania w bazie |
| --- | ---: | ---: | ---: |
| Polski | 10 | 47 | 265 |
| Matematyka | 6 | 30 | 300 |
| Angielski | 6 | 27 | 290 |
| Historia | 6 | 30 | 150 |
| Przyroda | 5 | 10 | 150 |
| **Razem** | **33** | **144** | **1155** |

- Każde podejście ma datę, punkty i wynik procentowy. Można przerwać test i wrócić do niego.
- Poprawki pojedynczych błędów zapisują się osobno i nie zmieniają pierwotnego wyniku.
- Generator układa nowe kombinacje 10, 15 lub 20 pytań z istniejącej bazy; nie wymaga zewnętrznego AI ani klucza API.
- Zadania obejmują wybór jednej lub wielu odpowiedzi, dopasowywanie, kolejność oraz krótkie wpisy. W przyrodzie są mapy, schematy i wykresy.
- Odpowiedź jednokrotnego wyboru zapisuje się od razu; w pozostałych zadaniach służą do tego „Zapisz odpowiedź” i „Dalej”. Każde całe poprawne zadanie daje 1 punkt.
- Wyniki można pobrać w CSV i JSON. Po wyniku, poprawce i utworzeniu nowego zestawu powstaje też spójna kopia bazy na serwerze.

## Uruchomienie z Dockerem

Wymagane: Docker z Docker Compose. Pobierz repozytorium przez **Code → Download ZIP** i rozpakuj, albo użyj **Fork** lub `git clone`.

W katalogu z `compose.yaml` uruchom:

```sh
docker compose up -d --build
```

Otwórz [http://localhost:8092](http://localhost:8092). Imię lub pseudonim zmienisz w „Ustawienia i materiały”.

Domyślnie portal jest dostępny tylko na komputerze, na którym go uruchomiono. Aby udostępnić go urządzeniom w domowej sieci, utwórz plik `.env` obok `compose.yaml`:

```dotenv
LISTEN_ADDRESS=0.0.0.0
PORT=8092
```

Ponownie uruchom `docker compose up -d`. Na drugim urządzeniu otwórz adres komputera lub serwera z portem `8092`, np. `http://ADRES_SERWERA:8092`.

To aplikacja dla zaufanej sieci domowej, bez logowania użytkowników. Każdy, kto ma dostęp do jej adresu, może używać profilu i odczytać wyniki. Nie wystawiaj jej bezpośrednio do Internetu; dostęp zdalny wymaga osobnego uwierzytelniania, np. przez VPN lub chroniony serwer pośredniczący.

### Dane i aktualizacje

Dane znajdują się w woluminie Dockera `learning-data`, zamontowanym jako `/data`. Zatrzymanie i ponowne uruchomienie kontenera nie usuwa historii. **Nie używaj `docker compose down -v`, jeśli chcesz ją zachować** — opcja `-v` usuwa wolumin z wynikami.

Po pobraniu nowej wersji kodu ponownie wykonaj `docker compose up -d --build`. Nie kopiuj cudzej bazy do swojego woluminu, jeśli chcesz zachować własną historię.

Kopia codzienna jest w `/data/backups/learning-RRRR-MM-DD.sqlite3`. Można skopiować istniejące kopie z kontenera:

```sh
mkdir -p backups
docker compose cp portal:/data/backups/. ./backups/
```

Folder powstaje po pierwszym wyniku, poprawce lub wygenerowaniu zestawu. Eksport JSON z ustawień zawiera pełne odpowiedzi i poprawki, a CSV zestawienie wyników. Nie publikuj tych plików. W repozytorium są reguły ignorowania danych i kopii; obraz Dockera otrzymuje wyłącznie kod, treści i grafikę.

## Uruchomienie bez Dockera

Wymagany Python 3.12 lub nowszy. Nie trzeba instalować bibliotek zewnętrznych.

macOS / Linux:

```sh
BIND=127.0.0.1 PORT=8092 python3 server.py
```

Windows PowerShell:

```powershell
$env:BIND = "127.0.0.1"
$env:PORT = "8092"
python server.py
```

Baza będzie w lokalnym folderze `data/`. Zmienne `DATA_DIR`, `BIND` i `PORT` pozwalają zmienić lokalizację danych, adres nasłuchiwania i port.

## Zakres materiału

Polski: ortografia, gramatyka, rodzaje wypowiedzeń i interpunkcja, „Akademia pana Kleksa” oraz „Magiczne drzewo. Czerwone krzesło”. Angielski: początek kursu New English Class 4 Pearson, czasownik *to be*, zaimki i diagnoza rozdziału 1. Matematyka: liczby, działania, ułamki, figury i miary. Historia: źródła, czas, mapa, wspólnota i wybrane tematy historii starożytnej. Przyroda: dział „Okiem badacza”, pięć rozdziałów po dwa rozłączne testy po 15 pytań.

Dobór tematów jest pomocą do nauki, a nie oficjalnym rozkładem rocznym ani materiałem wydawnictwa. Tempo i zakres pracy należy dopasować do szkoły i podręcznika. Linki do źródeł są w aplikacji oraz w `content/*.json`. Repozytorium nie zawiera zdjęć stron ani skanów podręczników.

## Rozwój i sprawdzenie działania

```sh
python3 -m unittest discover -s tests -v
node --check public/app.js
```

Node jest potrzebny tylko do opcjonalnego sprawdzenia składni JavaScript, nie do uruchomienia portalu. Testy korzystają z osobnych, tymczasowych baz.

Kod serwera: `server.py`. Interfejs: `public/`. Banki pytań i gotowe zestawy: `content/`. Testy: `tests/`.

Zachowuj unikalne identyfikatory pytań. Dawne podejścia przechowują własny zapis pytań i klucza, więc edycja banku nie zmienia zakończonych wyników. Jeśli zmieniasz skład gotowego zestawu, nadaj mu nowy identyfikator wersji.
