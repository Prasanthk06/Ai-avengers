// script.js


// 1. Grab the flip container
const flipContainer = document.getElementById("flip-container");

// 2. Links to flip between forms
const flipToSignup = document.getElementById("flip-to-signup");
const flipToSignin = document.getElementById("flip-to-signin");

// 3. Add event listeners
if (flipToSignup) {
  flipToSignup.addEventListener("click", (e) => {
    e.preventDefault();
    flipContainer.classList.add("flipped");
  });
}

if (flipToSignin) {
  flipToSignin.addEventListener("click", (e) => {
    e.preventDefault();
    flipContainer.classList.remove("flipped");
  });
}

// 4. (Optional) Toggle password visibility
const toggleButtons = document.querySelectorAll(".toggle-visibility");
toggleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "🙈";
    } else {
      input.type = "password";
      btn.textContent = "👁";
    }
  });
});


const loginForm = document.querySelector('.sign-in-form');
const signupForm = document.querySelector('.sign-up-form');


loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        email: document.getElementById('signin-email').value,
        uniqueCode: document.getElementById('signin-password').value
    };
    
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        const data = await response.json();
        if (data.success) {
            window.location.href = '/dashboard';
        } else {
            alert(data.message);
        }
    } catch (error) {
        alert('Login failed. Please try again.');
    }
});


signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        username: document.getElementById('signup-name').value,
        email: document.getElementById('signup-email').value
    };
    
    try {
        const response = await fetch('/signup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        const data = await response.json();
        if (data.success) {
            alert('Registration successful! Your WhatsApp verification code: ' + data.code);
            flipContainer.classList.remove('flipped');
        } else {
            alert(data.message); // This will show "This email is already registered"
        }
    } catch (error) {
        alert('Registration failed. Please try again.');
    }
});

document.getElementById('forgotCodeLink').addEventListener('click', () => {
    const email = prompt('Please enter your registered email address:');
    if (email) {
      fetch('/forgot-unique-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
      }).then(response => response.json())
        .then(data => {
          alert(data.message);
        }).catch(error => {
          alert('Failed to retrieve unique code. Please try again.');
        });
    }
});

function showMessage(elementId, message, type) {
    const messageElement = document.getElementById(elementId);
    messageElement.textContent = message;
    messageElement.className = `message ${type}`;
    setTimeout(() => {
        messageElement.textContent = '';
    }, 5000);
}